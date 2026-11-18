import { randomUUID } from "node:crypto";
import { CycleClient, type PermissionAnswer } from "@cycle/client";
import type { Channel } from "@cycle/transport/client";
import {
  type AgentInfo,
  type AppApi,
  type AppEvent,
  type Attention,
  applyUpdate,
  attentionOf,
  type Conversation,
  type EnvironmentConfig,
  type EnvironmentStatus,
  emptyConversation,
  type FileSearch,
  type FolderListing,
  type NewSession,
  type PermissionRequest,
  type PromptBlock,
  type SessionSnapshot,
  type SessionSummary,
} from "@cycle/ui";
import { daemonUpgradeCommand, isNewer } from "../shared/release.ts";
import { LOCAL_ENVIRONMENT, type Settings } from "./settings.ts";

export type ManagerOptions = {
  settings: Settings;
  /** How to reach an environment. The one place that knows about ssh, a local proxy, or a test socket. */
  channelFor: (environment: EnvironmentConfig) => () => Promise<Channel>;
  emit: (event: AppEvent) => void;
  chooseDirectory?: () => Promise<string | undefined>;
  backoff?: { first: number; max: number };
  /** The version of this app, to tell an environment whose daemon is older. Without it, nothing is said. */
  appVersion?: string;
  /** A session changed in a way worth telling (it asks, it is done, its agent is gone). Without it, nothing is said. */
  attention?: (notice: AttentionNotice) => void;
};

/** What the main process is told when a session that was changing is in a state that wants the person. */
export type AttentionNotice = {
  environmentId: string;
  environmentName: string;
  session: SessionSummary;
  kind: Attention;
};

type Pending = { request: PermissionRequest; answer: (answer: PermissionAnswer) => void };

/** What main holds for a session being watched, so a renderer that reloads can be given it whole. */
type Watched = {
  conversation: Conversation;
  pending: Map<string, Pending>;
  /** Events sent about this session. The renderer compares it with the snapshot it was given. */
  version: number;
};

type Connection = {
  client: CycleClient;
  status: EnvironmentStatus;
  sessions: SessionSummary[];
  watched: Map<string, Watched>;
  opening: Map<string, Promise<void>>;
  /** Counts the rereads of the list, and the newest one applied: an older answer arriving late is not applied over it. */
  asked: number;
  applied: number;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The main process's half of the app: the connections to daemons, and the state of every session
 * being watched. It is the whole of what the renderer can ask for (`AppApi`) and knows nothing of
 * Electron, so it is tested against a real daemon without a window.
 */
export class ConnectionManager
  implements Omit<AppApi, "chooseDirectory" | "updateState" | "checkForUpdate" | "installUpdate">
{
  readonly #options: ManagerOptions;
  #environments: EnvironmentConfig[] = [LOCAL_ENVIRONMENT];
  readonly #connections = new Map<string, Connection>();
  /** The last list read from each environment, kept when its connection goes: what the interface greys out. */
  readonly #lastSessions = new Map<string, SessionSummary[]>();
  /** Why the last attempt to connect to an environment failed, for a renderer that asks after the event went by. */
  readonly #lastError = new Map<string, string>();

  constructor(options: ManagerOptions) {
    this.#options = options;
  }

  async init(): Promise<void> {
    this.#environments = await this.#options.settings.load();
  }

  async close(): Promise<void> {
    for (const connection of this.#connections.values()) await connection.client.close();
    this.#connections.clear();
  }

  // ---- environments ----

  async environments() {
    return {
      environments: this.#environments,
      status: this.#environments.map((environment): EnvironmentStatus => {
        const error = this.#lastError.get(environment.id);
        return (
          this.#connections.get(environment.id)?.status ?? {
            environmentId: environment.id,
            state: "closed",
            ...(error !== undefined ? { error } : {}),
          }
        );
      }),
      sessions: Object.fromEntries(this.#lastSessions),
    };
  }

  /**
   * Connects to every environment, each on its own: one that cannot be reached is closed, with why, and the others
   * are not held up by it. What is wrong with an environment is in its status; nothing is thrown.
   */
  async connectAll(): Promise<void> {
    await Promise.allSettled(this.#environments.map((environment) => this.connect(environment.id)));
  }

  async saveEnvironment(environment: EnvironmentConfig): Promise<void> {
    if (environment.id === LOCAL_ENVIRONMENT.id)
      throw new Error("The local daemon cannot be changed");
    const rest = this.#environments.filter((h) => h.id !== environment.id);
    this.#environments = [...rest, environment];
    await this.#options.settings.save(this.#environments);
    this.#options.emit({ type: "environments", environments: this.#environments });
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    if (environmentId === LOCAL_ENVIRONMENT.id)
      throw new Error("The local daemon cannot be removed");
    await this.disconnect(environmentId);
    this.#lastSessions.delete(environmentId);
    this.#lastError.delete(environmentId);
    this.#environments = this.#environments.filter((h) => h.id !== environmentId);
    await this.#options.settings.save(this.#environments);
    this.#options.emit({ type: "environments", environments: this.#environments });
  }

  async connect(environmentId: string): Promise<void> {
    const existing = this.#connections.get(environmentId);
    if (existing && existing.status.state !== "closed") return;
    const environment = this.#environments.find((h) => h.id === environmentId);
    if (environment === undefined) throw new Error(`No such environment: ${environmentId}`);

    const connection: Connection = {
      client: undefined as unknown as CycleClient,
      status: { environmentId, state: "connecting" },
      sessions: [],
      watched: new Map(),
      opening: new Map(),
      asked: 0,
      applied: 0,
    };
    connection.client = new CycleClient({
      connect: this.#options.channelFor(environment),
      name: "cycle-desktop",
      ...(this.#options.backoff !== undefined ? { backoff: this.#options.backoff } : {}),
      events: {
        update: (sessionId, update) => this.#onUpdate(environmentId, connection, sessionId, update),
        permission: (sessionId, request, requestId) =>
          this.#onPermission(environmentId, connection, sessionId, request, requestId),
        resolved: (sessionId, requestId) =>
          this.#onResolved(environmentId, connection, sessionId, String(requestId)),
        listChanged: () =>
          void this.#refreshSessions(environmentId, connection).catch(() => undefined),
        defaultsChanged: (agent) =>
          this.#options.emit({ type: "agent-defaults", environmentId, agent }),
        gone: (sessionId) => this.#onGone(environmentId, connection, sessionId),
        connection: (state, error) => {
          // A connection that came back asks for the list again: it may have changed while away.
          const was = connection.status.state;
          if (state === was && error === undefined) return;
          connection.status = {
            environmentId,
            state,
            ...(error !== undefined ? { error: messageOf(error) } : {}),
            ...(state === "connected" ? this.#daemonOf(environment, connection.client) : {}),
            // What the daemon can do is known from the connection it said it on: a drop that comes back to the same
            // daemon does not take it away, or the box would stop queueing for as long as the line is down.
            ...(state === "connected"
              ? {
                  capabilities: {
                    queue: connection.client.capabilities.queue === true,
                    files: connection.client.capabilities.files === true,
                    folders: connection.client.capabilities.folders === true,
                  },
                }
              : state === "reconnecting" && connection.status.capabilities !== undefined
                ? { capabilities: connection.status.capabilities }
                : {}),
          };
          this.#options.emit({ type: "environment-status", ...connection.status });
          if (state === "connected" && was === "reconnecting") {
            void this.#refreshSessions(environmentId, connection, true).catch(() => undefined);
          }
        },
      },
    });
    this.#connections.set(environmentId, connection);
    this.#options.emit({ type: "environment-status", ...connection.status });
    try {
      await connection.client.start();
    } catch (error) {
      this.#connections.delete(environmentId);
      this.#lastError.set(environmentId, messageOf(error));
      this.#options.emit({
        type: "environment-status",
        environmentId,
        state: "closed",
        error: messageOf(error),
      });
      throw error;
    }
    this.#lastError.delete(environmentId);
    try {
      await this.#refreshSessions(environmentId, connection);
    } catch (error) {
      // A daemon that answers but cannot list is not usable: say so, instead of sitting connected with no list.
      this.#connections.delete(environmentId);
      await connection.client.close().catch(() => undefined);
      this.#lastError.set(environmentId, messageOf(error));
      this.#options.emit({
        type: "environment-status",
        environmentId,
        state: "closed",
        error: messageOf(error),
      });
      throw error;
    }
  }

  /** What a connected remote environment's daemon is, and whether it is behind this app. */
  #daemonOf(
    environment: EnvironmentConfig,
    client: CycleClient,
  ): Pick<EnvironmentStatus, "daemon"> {
    const version = client.serverVersion;
    if (environment.kind === "local" || version === undefined) return {};
    const { appVersion } = this.#options;
    const behind = appVersion !== undefined && isNewer(appVersion, version);
    return {
      daemon: { version, ...(behind ? { upgrade: daemonUpgradeCommand(appVersion) } : {}) },
    };
  }

  async disconnect(environmentId: string): Promise<void> {
    const connection = this.#connections.get(environmentId);
    if (connection === undefined) return;
    this.#connections.delete(environmentId);
    for (const watched of connection.watched.values()) {
      for (const pending of watched.pending.values()) pending.answer({ outcome: "cancelled" });
    }
    await connection.client.close();
    this.#options.emit({ type: "environment-status", environmentId, state: "closed" });
  }

  #connection(environmentId: string): Connection {
    const connection = this.#connections.get(environmentId);
    if (connection === undefined) throw new Error("Not connected to that environment");
    return connection;
  }

  // ---- sessions ----

  async sessions(environmentId: string): Promise<SessionSummary[]> {
    return this.#refreshSessions(environmentId, this.#connection(environmentId));
  }

  /**
   * Reads the session list and tells the renderer. `afterOutage`: the connection was away, so a session that went from
   * working to stopped may only have been released while nobody watched, and what finished is old news: only a session
   * that is asking (and is still asking) is told.
   */
  async #refreshSessions(
    environmentId: string,
    connection: Connection,
    afterOutage = false,
  ): Promise<SessionSummary[]> {
    const asked = ++connection.asked;
    const rows = await connection.client.listSessions();
    const sessions = rows.map((row): SessionSummary => {
      const meta = (row._meta ?? {}) as Record<string, unknown>;
      return {
        environmentId,
        sessionId: row.sessionId,
        cwd: row.cwd,
        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
        archived: meta["cycle/archived"] === true,
        agent: String(meta["cycle/agent"] ?? ""),
        state: (meta["cycle/state"] as SessionSummary["state"]) ?? "stopped",
        lastSeq: Number(meta["cycle/lastSeq"] ?? 0),
        ...(typeof meta["cycle/unread"] === "boolean" ? { unread: meta["cycle/unread"] } : {}),
        ...(typeof meta["cycle/background"] === "number"
          ? { background: meta["cycle/background"] }
          : {}),
        ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
        ...(typeof meta["cycle/config"] === "object" && meta["cycle/config"] !== null
          ? { config: meta["cycle/config"] as Record<string, string> }
          : {}),
      };
    });
    // An answer to an older question, arriving after the answer to a newer one, would put the list back.
    if (asked < connection.applied) return connection.sessions;
    connection.applied = asked;
    // The environment may have been removed while the question was out: its list must not come back.
    if (this.#connections.get(environmentId) !== connection) return sessions;
    const before = new Map(connection.sessions.map((s) => [s.sessionId, s]));
    connection.sessions = sessions;
    this.#lastSessions.set(environmentId, sessions);
    this.#options.emit({ type: "sessions", environmentId, sessions });
    this.#tell(environmentId, before, sessions, afterOutage);
    return sessions;
  }

  /** What changed since the list before is what the person may want to be told. A hook that fails must not break the list. */
  #tell(
    environmentId: string,
    before: ReadonlyMap<string, SessionSummary>,
    sessions: readonly SessionSummary[],
    afterOutage: boolean,
  ): void {
    const attention = this.#options.attention;
    if (attention === undefined) return;
    const environmentName =
      this.#environments.find((h) => h.id === environmentId)?.name ?? environmentId;
    for (const session of sessions) {
      const kind = attentionOf(before.get(session.sessionId), session);
      if (kind === undefined || (afterOutage && kind !== "needs-you")) continue;
      try {
        attention({ environmentId, environmentName, session, kind });
      } catch {
        // A notification that cannot be shown is a notification missed, not a list that cannot be read.
      }
    }
  }

  async createSession(environmentId: string, params: NewSession): Promise<string> {
    const connection = this.#connection(environmentId);
    const sessionId = await connection.client.newSession(params);
    await this.#refreshSessions(environmentId, connection);
    return sessionId;
  }

  async openSession(environmentId: string, sessionId: string): Promise<SessionSnapshot> {
    const connection = this.#connection(environmentId);
    let opening = connection.opening.get(sessionId);
    if (opening === undefined) {
      opening = this.#watch(connection, sessionId).finally(() =>
        connection.opening.delete(sessionId),
      );
      connection.opening.set(sessionId, opening);
    }
    await opening;
    const watched = connection.watched.get(sessionId);
    if (watched === undefined) throw new Error("The session is gone");
    return {
      conversation: watched.conversation,
      permissions: [...watched.pending.values()].map((p) => p.request),
      version: watched.version,
    };
  }

  async #watch(connection: Connection, sessionId: string): Promise<void> {
    if (connection.watched.has(sessionId)) return;
    const summary = connection.sessions.find((s) => s.sessionId === sessionId);
    if (summary === undefined) throw new Error("No such session");
    connection.watched.set(sessionId, {
      conversation: { ...emptyConversation(), replaying: true },
      pending: new Map(),
      version: 0,
    });
    try {
      await connection.client.watch(sessionId, summary.cwd);
    } catch (error) {
      connection.watched.delete(sessionId);
      throw error;
    }
  }

  /** A watched session was deleted elsewhere while the connection was away: nothing is waiting on it any more. */
  #onGone(environmentId: string, connection: Connection, sessionId: string): void {
    const watched = connection.watched.get(sessionId);
    if (watched === undefined) return;
    for (const pending of watched.pending.values()) pending.answer({ outcome: "cancelled" });
    connection.watched.delete(sessionId);
    // The renderer drops the view (and with it the permission dialogs), the draft and the selection.
    this.#options.emit({ type: "session-gone", environmentId, sessionId });
  }

  #onUpdate(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    update: Parameters<typeof applyUpdate>[1],
  ) {
    const watched = connection.watched.get(sessionId);
    if (watched === undefined) return;
    watched.conversation = applyUpdate(watched.conversation, update);
    watched.version += 1;
    this.#options.emit({
      type: "update",
      environmentId,
      sessionId,
      update,
      version: watched.version,
    });
  }

  async prompt(
    environmentId: string,
    sessionId: string,
    content: string | PromptBlock[],
  ): Promise<void> {
    const blocks =
      typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
    await this.#connection(environmentId).client.prompt(sessionId, blocks);
  }

  async cancel(environmentId: string, sessionId: string): Promise<void> {
    await this.#connection(environmentId).client.cancel(sessionId);
  }

  async listFolders(
    environmentId: string,
    path?: string,
    hidden?: boolean,
  ): Promise<FolderListing> {
    return this.#connection(environmentId).client.listFolders(path, hidden);
  }

  async searchFiles(environmentId: string, sessionId: string, query: string): Promise<FileSearch> {
    return this.#connection(environmentId).client.searchFiles(sessionId, query);
  }

  async dequeue(environmentId: string, sessionId: string, queueId: string): Promise<PromptBlock[]> {
    return (await this.#connection(environmentId).client.dequeue(
      sessionId,
      queueId,
    )) as PromptBlock[];
  }

  async setSessionConfig(
    environmentId: string,
    sessionId: string,
    configId: string,
    value: string,
  ) {
    await this.#connection(environmentId).client.setConfig(sessionId, configId, value);
  }

  async renameSession(environmentId: string, sessionId: string, title: string): Promise<void> {
    await this.#connection(environmentId).client.rename(sessionId, title);
  }

  async archiveSession(environmentId: string, sessionId: string, archived: boolean): Promise<void> {
    await this.#connection(environmentId).client.archive(sessionId, archived);
  }

  /**
   * The person has seen the session up to what the daemon has now. Never a seq past the log: the row's own
   * `lastSeq`. A daemon that cannot is not asked.
   */
  async markRead(environmentId: string, sessionId: string): Promise<void> {
    const connection = this.#connection(environmentId);
    // The list as the daemon has it now: a row read before the news came in would say a seq below it.
    const row = (await this.#refreshSessions(environmentId, connection)).find(
      (s) => s.sessionId === sessionId,
    );
    if (row === undefined) return;
    await connection.client.markRead(sessionId, row.lastSeq);
  }

  async deleteSession(environmentId: string, sessionId: string): Promise<void> {
    const connection = this.#connection(environmentId);
    await connection.client.delete(sessionId);
    connection.watched.delete(sessionId);
  }

  // ---- permissions ----

  #onPermission(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    request: Record<string, unknown>,
    requestId: string | undefined,
  ): Promise<PermissionAnswer> {
    const key = `${environmentId}:${sessionId}:${requestId ?? randomUUID()}`;
    return new Promise<PermissionAnswer>((resolve) => {
      let watched = connection.watched.get(sessionId);
      if (watched === undefined) {
        // Asked about a session not open here: nobody can answer it yet. Let the daemon ask again
        // when it is, rather than answering for the user.
        watched = {
          conversation: { ...emptyConversation(), replaying: true },
          pending: new Map(),
          version: 0,
        };
        connection.watched.set(sessionId, watched);
      }
      const old = watched.pending.get(key);
      // The daemon asks again after a reconnect: the request is the same, the answer goes to the new ask.
      old?.answer({ outcome: "cancelled" });
      const built: PermissionRequest = {
        key,
        environmentId,
        sessionId,
        title: String(request.title ?? "Permission"),
        subject: request.subject,
        options: (request.options as PermissionRequest["options"]) ?? [],
      };
      watched.pending.set(key, { request: built, answer: resolve });
      if (old === undefined) {
        watched.version += 1;
        this.#options.emit({ type: "permission", request: built, version: watched.version });
      }
    });
  }

  async answerPermission(key: string, optionId: string | "cancelled"): Promise<void> {
    for (const [environmentId, connection] of this.#connections) {
      for (const [sessionId, watched] of connection.watched) {
        const pending = watched.pending.get(key);
        if (pending === undefined) continue;
        pending.answer(
          optionId === "cancelled" ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        );
        this.#closePermission(environmentId, sessionId, watched, key);
        return;
      }
    }
  }

  #closePermission(environmentId: string, sessionId: string, watched: Watched, key: string): void {
    watched.pending.delete(key);
    watched.version += 1;
    this.#options.emit({
      type: "permission-closed",
      environmentId,
      sessionId,
      key,
      version: watched.version,
    });
  }

  #onResolved(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    requestId: string,
  ): void {
    const watched = connection.watched.get(sessionId);
    const key = `${environmentId}:${sessionId}:${requestId}`;
    const pending = watched?.pending.get(key);
    if (watched === undefined || pending === undefined) return;
    // Answered somewhere else. Free this client's request, and close the dialog.
    pending.answer({ outcome: "cancelled" });
    this.#closePermission(environmentId, sessionId, watched, key);
  }

  // ---- agents ----

  async agents(environmentId: string): Promise<AgentInfo[]> {
    return (await this.#connection(environmentId).client.agents()).agents;
  }

  async agentDefaults(environmentId: string, agent: string): Promise<Record<string, string>> {
    return this.#connection(environmentId).client.agentDefaults(agent);
  }

  async setAgentDefaults(
    environmentId: string,
    agent: string,
    config: Record<string, string>,
  ): Promise<void> {
    await this.#connection(environmentId).client.setAgentDefaults(agent, config);
  }

  chooseDirectory(): Promise<string | undefined> {
    return this.#options.chooseDirectory?.() ?? Promise.resolve(undefined);
  }
}
