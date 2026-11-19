import {
  client as acpClient,
  type ClientContext,
  type ContentBlock,
  methods,
  type SessionUpdate,
} from "@cycle/acp";
import {
  CYCLE_PROTOCOL_VERSION,
  type FolderList,
  META,
  NOTIFICATIONS,
  seqOf,
} from "@cycle/protocol";
import type { Channel } from "@cycle/transport/client";

/** ACP's "resource not found": the daemon has no such session. */
const RESOURCE_NOT_FOUND = -32002;

const isSessionGone = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === RESOURCE_NOT_FOUND;

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

/** What the daemon asks of the user. Resolve with the chosen option, or `cancelled`. */
export type PermissionAnswer = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/** What a user answered to a form: ACP's `elicitation/create` response. */
export type ElicitationAnswer =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export type ClientEvents = {
  /**
   * The agent asks the user for structured input. Having this says the client can show a form:
   * the daemon asks no form of a client that does not (docs/protocol.md §9). `resolved` closes it
   * when someone else answers first.
   */
  elicitation?: (
    sessionId: string,
    request: Record<string, unknown>,
    requestId: string | undefined,
  ) => Promise<ElicitationAnswer>;
  /** An update of a session, once each: a replay after a reconnect never repeats one. */
  update?: (sessionId: string, update: SessionUpdate, seq: number | undefined) => void;
  /** The agent wants permission. If this is missing, the request is answered "cancelled". */
  permission?: (
    sessionId: string,
    request: Record<string, unknown>,
    /** The daemon's id for it: `resolved` names the same one. Absent from an older daemon. */
    requestId: string | undefined,
  ) => Promise<PermissionAnswer>;
  /** A request this client was asked has been answered somewhere else: close its dialog. */
  resolved?: (sessionId: string, requestId: string | number, outcome: unknown) => void;
  /** Sessions were created, deleted, archived, renamed or changed state: list them again. */
  listChanged?: () => void;
  /** An agent's defaults were changed, here or by another client. */
  defaultsChanged?: (agent: string) => void;
  /**
   * A session this client was watching no longer exists on the daemon (another client deleted it
   * while this one was away). It is not watched any more; the others carry on.
   */
  gone?: (sessionId: string) => void;
  connection?: (state: ConnectionState, error?: unknown) => void;
};

export type ClientOptions = {
  /** Makes a new connection to the daemon. Called again after each loss. */
  connect: () => Promise<Channel>;
  events?: ClientEvents;
  /** Waits between attempts to reconnect, in ms. */
  backoff?: { first: number; max: number };
  name?: string;
};

export type SessionRow = {
  sessionId: string;
  cwd: string;
  /** When the session last had something happen in it. Absent from a daemon older than protocol 0.2. */
  updatedAt?: string | null;
  _meta?: Record<string, unknown> | null;
};

/**
 * A client of the daemon that keeps its place. It remembers the last `cycle/seq` of every session it
 * watches; when the connection is lost it reconnects, and asks for what it missed, so the caller sees
 * each update once, in order, as if nothing had happened (docs/protocol.md §7).
 */
export class CycleClient {
  readonly #options: ClientOptions;
  readonly #events: ClientEvents;
  /** Sessions being watched: where each is up to, and where it runs. */
  readonly #watched = new Map<string, { cwd: string; lastSeq: number; replayed: boolean }>();
  #agent: ClientContext | undefined;
  #channel: Channel | undefined;
  #closing = false;
  #state: ConnectionState = "closed";
  #reconnecting: Promise<void> | undefined;
  #capabilities: Record<string, unknown> = {};
  #serverVersion: string | undefined;

  constructor(options: ClientOptions) {
    this.#options = options;
    this.#events = options.events ?? {};
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** What the daemon said it can do, from `initialize`. */
  /** What the daemon says it is (its release, or `dev`), as of the last connection. */
  get serverVersion(): string | undefined {
    return this.#serverVersion;
  }

  get capabilities(): Record<string, unknown> {
    return this.#capabilities;
  }

  /** Connects. Fails if the first attempt does; later losses are retried. */
  async start(): Promise<void> {
    this.#setState("connecting");
    try {
      await this.#connectOnce();
    } catch (error) {
      this.#setState("closed", error);
      throw error;
    }
    this.#setState("connected");
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#channel?.close();
    this.#setState("closed");
  }

  // ---- what to ask the daemon ----

  async agents() {
    return (await this.#request("_cycle/agents/list", {})) as {
      agents: {
        id: string;
        name: string;
        available: boolean;
        configSchema: Record<string, unknown>;
      }[];
    };
  }

  /** What new sessions of an agent start with. */
  async agentDefaults(agent: string): Promise<Record<string, string>> {
    const answer = (await this.#request("_cycle/agent_defaults/read", { agent })) as {
      config: Record<string, string>;
    };
    return answer.config;
  }

  async setAgentDefaults(agent: string, config: Record<string, string>): Promise<void> {
    await this.#request("_cycle/agent_defaults/set", { agent, config });
  }

  async listSessions(): Promise<SessionRow[]> {
    const answer = (await this.#request(methods.agent.session.list, {})) as {
      sessions: SessionRow[];
    };
    return answer.sessions;
  }

  async newSession(params: {
    cwd: string;
    agent?: string;
    config?: Record<string, string>;
    mcpServers?: unknown[];
  }): Promise<string> {
    const meta: Record<string, unknown> = {};
    if (params.agent !== undefined) meta[META.agent] = params.agent;
    if (params.config !== undefined) meta[META.config] = params.config;
    const answer = (await this.#request(methods.agent.session.new, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      _meta: meta,
    })) as { sessionId: string };
    return answer.sessionId;
  }

  /**
   * Starts watching a session. The first time, its whole history is sent; after a reconnect, only
   * what was missed. Resolves when the replay is done.
   */
  async watch(sessionId: string, cwd: string): Promise<void> {
    const entry = this.#watched.get(sessionId) ?? { cwd, lastSeq: 0, replayed: false };
    this.#watched.set(sessionId, entry);
    try {
      await this.#attach(sessionId, entry);
    } catch (error) {
      // A session that is not there is not kept to be asked for at every reconnect.
      if (isSessionGone(error)) this.#watched.delete(sessionId);
      throw error;
    }
  }

  unwatch(sessionId: string): void {
    this.#watched.delete(sessionId);
  }

  /**
   * Sends a prompt. While the agent works it is queued, or with `steer` put into the running turn
   * where the agent can take it (docs/protocol.md §8); a daemon that cannot queues it.
   */
  async prompt(
    sessionId: string,
    content: ContentBlock[],
    options: { steer?: boolean } = {},
  ): Promise<string> {
    const answer = (await this.#request(methods.agent.session.prompt, {
      sessionId,
      prompt: content,
      ...(options.steer === true ? { _meta: { [META.steer]: true } } : {}),
    })) as { messageId: string };
    return answer.messageId;
  }

  /** Takes a queued prompt back (docs/protocol.md §8). Rejects if it was sent, or handed back, meanwhile. */
  async dequeue(sessionId: string, queueId: string): Promise<unknown[]> {
    const answer = (await this.#request("_cycle/prompt/dequeue", { sessionId, queueId })) as {
      prompt: unknown[];
    };
    return answer.prompt;
  }

  /**
   * Finds files and folders in the session's folder on the daemon's machine, or in a folder given for a conversation that
   * has no session yet: that needs a daemon that says `filesInFolder` (docs/protocol.md §8).
   */
  async searchFiles(
    where: string | { cwd: string },
    query: string,
    limit?: number,
  ): Promise<{
    root: string;
    entries: { path: string; kind: "file" | "folder" }[];
    truncated: boolean;
  }> {
    return (await this.#request("_cycle/files/search", {
      ...(typeof where === "string" ? { sessionId: where } : { cwd: where.cwd }),
      query,
      ...(limit !== undefined ? { limit } : {}),
    })) as {
      root: string;
      entries: { path: string; kind: "file" | "folder" }[];
      truncated: boolean;
    };
  }

  /**
   * The folders in a folder on the daemon's machine, for choosing where a session works (docs/protocol.md §8). Without a
   * path: the daemon's user's home. A daemon that does not say it can is older: it is not asked.
   */
  async listFolders(path?: string, hidden?: boolean): Promise<FolderList> {
    if (this.#capabilities.folders !== true)
      throw new Error("This daemon is too old to list its folders");
    return (await this.#request("_cycle/folders/list", {
      ...(path !== undefined ? { path } : {}),
      ...(hidden === true ? { hidden } : {}),
    })) as FolderList;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#api().notify(methods.agent.session.cancel, { sessionId } as never);
  }

  async setConfig(sessionId: string, configId: string, value: string): Promise<void> {
    await this.#request(methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      type: "id",
      value,
    });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.#request("_cycle/session/set_title", { sessionId, title });
  }

  /**
   * Says this client has seen the session up to `seq`: its unread mark clears (protocol 0.2).
   * A daemon that does not say it takes `markRead` is older, and is not asked.
   */
  async markRead(sessionId: string, seq: number): Promise<void> {
    const ops = this.#capabilities.sessionOps;
    if (!Array.isArray(ops) || !ops.includes("markRead")) return;
    await this.#request("_cycle/session/mark_read", { sessionId, seq });
  }

  async archive(sessionId: string, archived = true): Promise<void> {
    await this.#request(archived ? "_cycle/session/archive" : "_cycle/session/unarchive", {
      sessionId,
    });
  }

  /** Removes a session's history for good. The caller asks the user first. */
  async delete(sessionId: string): Promise<void> {
    this.unwatch(sessionId);
    await this.#request(methods.agent.session.delete, { sessionId });
  }

  // ---- the connection ----

  #api(): ClientContext {
    if (this.#agent === undefined || this.#state !== "connected") {
      throw new Error("Not connected to the daemon");
    }
    return this.#agent;
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    return this.#api().request(method as never, params as never);
  }

  async #attach(
    sessionId: string,
    entry: { cwd: string; lastSeq: number; replayed: boolean },
    api: ClientContext = this.#api(),
  ) {
    // The first attach asks for everything; after that, only what came after what was seen.
    const replayFrom = entry.replayed
      ? { type: "_cycle.seq", after: entry.lastSeq }
      : { type: "start" };
    await api.request(methods.agent.session.resume, {
      sessionId,
      cwd: entry.cwd,
      replayFrom,
    } as never);
    entry.replayed = true;
  }

  async #connectOnce(): Promise<void> {
    const channel = await this.#options.connect();
    const app = acpClient({ name: this.#options.name ?? "cycle-client" })
      .onNotification(methods.client.session.update, ({ params }) => {
        this.#onUpdate(params.sessionId, params.update, seqOf(params._meta));
      })
      .onRequest(methods.client.elicitation.create, async ({ params }) => {
        const handler = this.#events.elicitation;
        const sessionId = (params as { sessionId?: string }).sessionId;
        const id = (params._meta as Record<string, unknown> | null | undefined)?.[META.requestId];
        if (handler === undefined || sessionId === undefined) return { action: "cancel" } as never;
        return (await handler(
          sessionId,
          params as unknown as Record<string, unknown>,
          typeof id === "string" ? id : undefined,
        )) as never;
      })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        const handler = this.#events.permission;
        const id = (params._meta as Record<string, unknown> | null | undefined)?.[META.requestId];
        const answer = handler
          ? await handler(
              params.sessionId,
              params as unknown as Record<string, unknown>,
              typeof id === "string" ? id : undefined,
            )
          : { outcome: "cancelled" as const };
        return { outcome: answer } as never;
      })
      .onNotification(
        NOTIFICATIONS.requestResolved,
        (p: unknown) => p as { sessionId: string; requestId: string | number; outcome: unknown },
        ({ params }) => this.#events.resolved?.(params.sessionId, params.requestId, params.outcome),
      )
      .onNotification(
        NOTIFICATIONS.agentDefaultsChanged,
        (p: unknown) => p as { agent: string },
        ({ params }) => this.#events.defaultsChanged?.(params.agent),
      )
      .onNotification(
        NOTIFICATIONS.sessionListChanged,
        (p: unknown) => p as object,
        () => this.#events.listChanged?.(),
      );
    const connection = app.connect(channel.stream);
    try {
      const answer = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: this.#options.name ?? "cycle-client", version: "0.0.0" },
        capabilities: this.#events.elicitation !== undefined ? { elicitation: { form: {} } } : {},
        _meta: { [META.protocolVersion]: CYCLE_PROTOCOL_VERSION },
      } as never);
      const info = (answer as { info?: { version?: unknown } }).info;
      this.#serverVersion = typeof info?.version === "string" ? info.version : undefined;
      this.#capabilities =
        ((answer as { _meta?: Record<string, unknown> })._meta?.[META.capabilities] as Record<
          string,
          unknown
        >) ?? {};
    } catch (error) {
      // Whatever the far side said is the reason; the protocol's own error is only that it hung up.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const said = channel.diagnostics?.() ?? "";
      channel.close();
      if (said === "") throw error;
      throw new Error(said, { cause: error });
    }
    this.#channel = channel;
    this.#agent = connection.agent;
    void connection.closed.then(() => this.#lost(channel));
  }

  #onUpdate(sessionId: string, update: SessionUpdate, seq: number | undefined): void {
    const entry = this.#watched.get(sessionId);
    // `replay_complete` carries the seq it replayed up to, as a place; it is not a record, and a
    // second one after a reconnect has the same seq as the last record seen.
    const isRecord = seq !== undefined && update.sessionUpdate !== "replay_complete";
    if (isRecord && entry !== undefined) {
      // A replay after a reconnect can overlap what was already seen: show each record once.
      if (seq <= entry.lastSeq) return;
      entry.lastSeq = seq;
    }
    this.#events.update?.(sessionId, update, seq);
  }

  #lost(channel: Channel): void {
    if (this.#closing || this.#channel !== channel) return;
    this.#agent = undefined;
    this.#channel = undefined;
    this.#setState("reconnecting");
    this.#reconnecting ??= this.#reconnect().finally(() => {
      this.#reconnecting = undefined;
    });
  }

  async #reconnect(): Promise<void> {
    const backoff = this.#options.backoff ?? { first: 250, max: 5_000 };
    let wait = backoff.first;
    while (!this.#closing) {
      try {
        await this.#connectOnce();
        // Back in the same place: ask for what was missed in every session being watched. The
        // client is not "connected" to anyone until that is done.
        const api = this.#agent;
        if (api === undefined) throw new Error("The connection was lost again");
        for (const [sessionId, entry] of [...this.#watched]) {
          // Dropped (unwatched, or gone) since the list was taken: not asked for.
          if (this.#watched.get(sessionId) !== entry) continue;
          try {
            await this.#attach(sessionId, entry, api);
          } catch (error) {
            // One session that is gone is that session's end, not the host's: the rest are
            // attached. Anything else (the connection itself) is tried again from the start.
            if (!isSessionGone(error)) throw error;
            this.#watched.delete(sessionId);
            this.#events.gone?.(sessionId);
          }
        }
        this.#setState("connected");
        return;
      } catch (error) {
        this.#agent = undefined;
        this.#channel?.close();
        this.#channel = undefined;
        this.#state = "reconnecting";
        this.#events.connection?.("reconnecting", error);
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait = Math.min(wait * 2, backoff.max);
      }
    }
  }

  #setState(state: ConnectionState, error?: unknown): void {
    this.#state = state;
    this.#events.connection?.(state, error);
  }
}
