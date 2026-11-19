import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type AgentContext,
  agent as acpAgent,
  type ClientApp,
  type McpServer,
  methods,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk/experimental/v2";
import {
  agentDefaultsRead,
  agentDefaultsSet,
  agentsList,
  CONNECTORS_CHANGED,
  CYCLE_PROTOCOL_VERSION,
  CycleErrorCode,
  type CycleMethod,
  checkPrompt,
  connectorsAdd,
  connectorsAuthClear,
  connectorsAuthFinish,
  connectorsAuthStart,
  connectorsList,
  connectorsRemove,
  connectorsUpdate,
  filesSearch,
  foldersList,
  META,
  NOTIFICATIONS,
  promptDequeue,
  QUEUE_LIMIT,
  QUEUE_UPDATE,
  type QueueEntry,
  type QueueReason,
  QueueUpdateSchema,
  ReplayFromSeqSchema,
  SessionUsageSchema,
  sessionArchive,
  sessionMarkRead,
  sessionSetTitle,
  sessionUnarchive,
  trustRead,
  trustSet,
} from "@cycle/protocol";
import type { z } from "zod";
import { AgentLink } from "./agent-link.ts";
import type { AgentDefinition } from "./agents.ts";
import { ConnectorService } from "./connectors/service.ts";
import { blobsDir, defaultsPath, indexPath, sessionsDir, trustPath } from "./data-dir.ts";
import { AgentDefaults } from "./defaults-file.ts";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  logUnavailable,
  queueFull,
  RESOURCE_NOT_FOUND,
  RpcError,
  sessionBusy,
  sessionNotFound,
  UNSUPPORTED_VERSION,
} from "./errors.ts";
import { searchFiles } from "./files.ts";
import { listFolders } from "./folders.ts";
import { type SessionEntry, SessionIndex } from "./index-file.ts";
import { BlobLogStore } from "./log/blobs.ts";
import { JsonlLogStore } from "./log/jsonl.ts";
import { attach } from "./log/replay.ts";
import type { LogRecord, LogStore, NewRecord, SessionLog } from "./log/types.ts";
import { redactParams, redactRecord } from "./redact.ts";
import {
  type Attachment,
  type ClientConn,
  HISTORY_NOT_SAVED,
  type Pending,
  Session,
} from "./session.ts";
import { checkToolResult } from "./tool-result.ts";
import { FolderTrust, realFolder, within } from "./trust-file.ts";

export type DaemonOptions = {
  /** Where the daemon keeps its data. Always given: nothing here guesses a home. */
  dataDir: string;
  agents: AgentDefinition[];
  /** For tests: replaces the JSONL store. */
  store?: LogStore;
  /** What this build is, told to every client that connects. Default `dev`: not a release. */
  version?: string;
  /**
   * How many sessions may have an agent running that has not been given a prompt yet. Past it, a new session
   * lets go of the oldest such agent: the next prompt starts one again. For an agent that is started when its
   * session is made (decision 0014), where each session has a process of its own and no agent can see the others.
   * No limit when it is not given.
   */
  maxAheadAgents?: number;
  /** For tests: replaces the connectors kept in `$CYCLE_HOME/connectors/` (docs/protocol.md §14). */
  connectors?: ConnectorService;
};

const SESSION_UPDATE = methods.client.session.update;
const REQUEST_PERMISSION = methods.client.session.requestPermission;
const ELICITATION = methods.client.elicitation.create;

/** The value each of an agent's `configOptions` has now, as a configuration. */
const currentValues = (options: unknown): Record<string, string> => {
  const config: Record<string, string> = {};
  if (Array.isArray(options)) {
    for (const option of options as { configId?: unknown; currentValue?: unknown }[]) {
      if (typeof option?.configId === "string" && typeof option.currentValue === "string") {
        config[option.configId] = option.currentValue;
      }
    }
  }
  return config;
};

const stringConfig = (value: unknown): Record<string, string> => {
  const config: Record<string, string> = {};
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") config[key] = item;
    }
  }
  return config;
};

/**
 * The daemon: Cycle's side of docs/protocol.md. It owns the sessions and their history, runs the
 * agents, and serves any number of clients. A client sees a session through the session's log, so
 * replay and live updates are one path.
 */
const ANSWER_ACTIONS = ["accept", "decline", "cancel"];

/** A client's answer to a form as the agent may see it: its action and its content, nothing else a client could add (such as the daemon's own `_meta`). Anything that is not an answer is a cancel. */
const elicitationAnswer = (response: unknown): { action: string; content?: object } => {
  const r = (typeof response === "object" && response !== null ? response : {}) as {
    action?: unknown;
    content?: unknown;
  };
  if (typeof r.action !== "string" || !ANSWER_ACTIONS.includes(r.action)) {
    return { action: "cancel" };
  }
  if (r.action === "accept" && typeof r.content === "object" && r.content !== null) {
    return { action: "accept", content: r.content };
  }
  return { action: r.action };
};

const withoutContent = (outcome: unknown): unknown => {
  if (typeof outcome !== "object" || outcome === null) return outcome;
  const { content: _content, ...rest } = outcome as Record<string, unknown>;
  return rest;
};

/**
 * The values a `configSchema` property allows when it lists them and takes no others: its `enum`, or
 * the `const` of each `oneOf` entry. Undefined for a property that lists none, or says it is open.
 */
const closedChoices = (property: unknown): unknown[] | undefined => {
  if (typeof property !== "object" || property === null) return undefined;
  const {
    enum: values,
    oneOf,
    _meta,
  } = property as {
    enum?: unknown;
    oneOf?: unknown;
    _meta?: Record<string, unknown>;
  };
  if (_meta?.[META.open] === true) return undefined;
  if (Array.isArray(values)) return values;
  if (Array.isArray(oneOf)) {
    const consts = oneOf.map((entry) => (entry as { const?: unknown } | null)?.const);
    return consts.every((value) => value !== undefined) ? consts : undefined;
  }
  return undefined;
};

export class Daemon {
  readonly #version: string;
  readonly #agents: Map<string, AgentDefinition>;
  readonly #store: LogStore;
  readonly #index: SessionIndex;
  readonly #defaults: AgentDefaults;
  readonly #trust: FolderTrust;
  readonly #connectors: ConnectorService;
  readonly #maxAhead: number | undefined;
  readonly #sessions = new Map<string, Session>();
  /** Sessions being loaded, so a second request for one waits for the first load. */
  readonly #loading = new Map<string, Promise<Session>>();
  readonly #conns = new Set<ClientConn>();
  #counter = 0;
  #closing = false;

  private constructor(
    options: DaemonOptions,
    index: SessionIndex,
    defaults: AgentDefaults,
    trust: FolderTrust,
    connectors: ConnectorService,
  ) {
    this.#version = options.version ?? "dev";
    this.#maxAhead = options.maxAheadAgents;
    this.#agents = new Map(options.agents.map((a) => [a.id, a]));
    this.#store =
      options.store ??
      new BlobLogStore(
        new JsonlLogStore({ dir: sessionsDir(options.dataDir) }),
        blobsDir(options.dataDir),
      );
    this.#index = index;
    this.#defaults = defaults;
    this.#trust = trust;
    this.#connectors = connectors;
    connectors.onChanged(() => {
      for (const conn of this.#conns) {
        void conn.notify(CONNECTORS_CHANGED, {}).catch(() => {});
      }
    });
  }

  /** Reads the index, and refuses to start if it is there and cannot be read. */
  static async start(options: DaemonOptions): Promise<Daemon> {
    return new Daemon(
      options,
      await SessionIndex.load(indexPath(options.dataDir)),
      await AgentDefaults.load(defaultsPath(options.dataDir)),
      await FolderTrust.load(trustPath(options.dataDir)),
      options.connectors ?? (await ConnectorService.load(options.dataDir)),
    );
  }

  /** Serves one client on a stream. */
  accept(stream: Stream): { closed: Promise<void>; close: () => void } {
    const holder: { value?: ClientConn } = {};
    return this.#register(holder, this.#facing(holder).connect(stream));
  }

  /** Serves a client app in this process, with no transport. For tests. */
  acceptApp(clientApp: ClientApp): { closed: Promise<void>; close: () => void } {
    const holder: { value?: ClientConn } = {};
    return this.#register(holder, this.#facing(holder).connect(clientApp));
  }

  #register(
    holder: { value?: ClientConn },
    connection: { client: AgentContext; closed: Promise<void>; close: () => void },
  ): { closed: Promise<void>; close: () => void } {
    const client = connection.client;
    const conn: ClientConn = {
      id: `c${++this.#counter}`,
      notify: (method, params) => client.notify(method as never, params as never),
      request: (method, params) => client.request(method as never, params as never),
      elicitation: false,
    };
    holder.value = conn;
    this.#conns.add(conn);
    void connection.closed.then(() => this.#dropped(conn));
    return { closed: connection.closed, close: () => connection.close() };
  }

  async close(): Promise<void> {
    // Stopping the agents is not a reason to hand anything back: what waits stays for the next start.
    this.#closing = true;
    for (const session of this.#sessions.values()) {
      session.closed = true;
      session.link?.kill();
      for (const attachment of session.attachments) attachment.detach();
      await session.log.close();
    }
    this.#sessions.clear();
    this.#connectors.close();
    // What the sessions noted as they went (an unread mark, a usage) is written by now, not dropped.
    await this.#index.flush();
  }

  #dropped(conn: ClientConn): void {
    this.#conns.delete(conn);
    for (const session of this.#sessions.values()) {
      for (const attachment of [...session.attachments]) {
        if (attachment.conn === conn) {
          attachment.detach();
          session.attachments.delete(attachment);
        }
      }
      this.#abandonForms(session);
    }
  }

  /** Whether some attached client has said it can answer a form. */
  #canAskForms(session: Session): boolean {
    return [...session.attachments].some((attachment) => attachment.conn.elicitation);
  }

  /**
   * A form is asked only while some attached client can answer it. When the last one goes the
   * agent is told so, as it is when none is attached to begin with, instead of waiting for a client
   * that may never come back (decision 0011).
   */
  #abandonForms(session: Session): void {
    if (this.#canAskForms(session)) return;
    for (const pending of [...session.pending.values()]) {
      if (pending.method === ELICITATION) {
        this.#settle(session, pending, { action: "cancel", _meta: { [META.noClient]: true } });
      }
    }
  }

  #changed(): void {
    for (const conn of this.#conns)
      void conn.notify(NOTIFICATIONS.sessionListChanged, {}).catch(() => {});
  }

  #definition(id: string): AgentDefinition {
    const definition = this.#agents.get(id);
    if (definition === undefined) {
      throw new RpcError(CycleErrorCode.AgentUnavailable, "No such agent", { agent: id });
    }
    return definition;
  }

  /**
   * A loaded session, loading it from the index and its log if it is not yet. Everyone who asks
   * while it loads gets the one load: a log has a single writer, and two loads would be two.
   */
  #session(sessionId: string): Promise<Session> {
    const loaded = this.#sessions.get(sessionId);
    // A session being deleted is already gone to everyone who asks.
    if (loaded?.closed) return Promise.reject(sessionNotFound(sessionId));
    if (loaded !== undefined) return Promise.resolve(loaded);
    const loading = this.#loading.get(sessionId);
    if (loading !== undefined) return loading;
    const entry = this.#index.get(sessionId);
    if (entry === undefined) return Promise.reject(sessionNotFound(sessionId));
    const load = (async () => {
      const log = await this.#store.open(sessionId, "existing");
      const session = new Session(sessionId, entry, log);
      // The queue is the last snapshot in the log; the index says whether there is anything to look for.
      if (entry.queued === true) session.queue = await this.#queueIn(log);
      this.#clamp(session);
      this.#watch(session);
      this.#sessions.set(sessionId, session);
      return session;
    })().finally(() => {
      this.#loading.delete(sessionId);
    });
    this.#loading.set(sessionId, load);
    return load;
  }

  // ---- agents ----

  /**
   * What the agent is told of the session's folder: `cycle/trusted` when someone has decided
   * (docs/protocol.md §8 "信任文件夹"), nothing when nobody has or the folder is gone.
   */
  async #trustMeta(cwd: string): Promise<Record<string, boolean>> {
    const real = await realFolder(cwd).catch(() => undefined);
    const trusted = real === undefined ? null : this.#trust.of(real).trusted;
    return trusted === null ? {} : { [META.trusted]: trusted };
  }

  /**
   * A decision changed: every agent in that folder was started with the old one, and would write it
   * back each time it starts a process. Each is stopped as soon as it has nothing to do (now, for an
   * idle one), so the next prompt starts it again with the new decision.
   */
  async #applyTrust(folder: string): Promise<void> {
    const running = [...this.#sessions.values()].filter(
      (s) => s.link !== undefined || s.starting !== undefined,
    );
    const reals = new Map<string, string | undefined>();
    await Promise.all(
      [...new Set(running.map((s) => s.entry.cwd))].map(async (cwd) => {
        reals.set(cwd, await realFolder(cwd).catch(() => undefined));
      }),
    );
    for (const session of running) {
      const real = reals.get(session.entry.cwd);
      if (real === undefined || !within(real, folder)) continue;
      session.trustStale = true;
      this.#restartIfStale(session);
    }
  }

  /**
   * An agent started for a session that has had no prompt holds a process for nothing yet. Past `maxAheadAgents` of
   * them, the oldest is let go (the session `keep` is the newest, and stays): its next prompt starts one again.
   */
  #letGoOfOldestAhead(keep: Session): void {
    const limit = this.#maxAhead;
    if (limit === undefined) return;
    const ahead = [...this.#sessions.values()].filter(
      (s) =>
        s.link !== undefined &&
        s.starting === undefined &&
        s.entry.prompted !== true &&
        s.status() === "idle" &&
        s.queue.length === 0,
    );
    for (const old of ahead.slice(0, Math.max(0, ahead.length - limit))) {
      if (old !== keep) old.link?.kill();
    }
  }

  /** Stops an agent started with a trust decision that has changed since, once it has nothing to do. */
  #restartIfStale(session: Session): void {
    if (!session.trustStale) return;
    if (session.link === undefined && session.starting === undefined) {
      // No agent: the next one is started with the decision as it is then.
      session.trustStale = false;
      return;
    }
    if (session.link === undefined || session.starting !== undefined) return;
    if (session.status() !== "idle" || session.queue.length > 0) return;
    if (session.backgroundCount() > 0) return;
    session.trustStale = false;
    session.link.kill();
  }

  /** Starts the agent for a session and has it create or resume it. */
  async #startAgent(session: Session, mode: "new" | "resume", create?: Record<string, unknown>) {
    const definition = this.#definition(session.entry.agent);
    const trust = await this.#trustMeta(session.entry.cwd);
    // The connection can end before connect() has returned the link (an agent that fails to start,
    // or exits at once): the end is noted, and acted on once there is a link to act on.
    let connected: AgentLink | undefined;
    let endedEarly = false;
    const link = await AgentLink.connect(definition, {
      update: (update) => this.#onUpdate(session, update),
      permission: (params) => this.#onPermission(session, params),
      elicitation: (params) => this.#onElicitation(session, params),
      closed: () => {
        if (connected === undefined) endedEarly = true;
        else this.#onAgentClosed(session, connected);
      },
    });
    connected = link;
    session.link = link;
    if (endedEarly) this.#onAgentClosed(session, link);
    try {
      // Cycle's connectors, each through the gateway (docs/protocol.md §14). A session's own servers keep their names.
      const own = ((mode === "new" ? create?.mcpServers : undefined) ??
        session.entry.mcpServers ??
        []) as McpServer[];
      const connectors = link.mcpHttp
        ? await this.#connectors.serversFor(
            session.id,
            session.entry.cwd,
            new Set(own.map((server) => (server as { name: string }).name)),
          )
        : [];
      const mcpServers = [...own, ...connectors];
      if (mode === "new") {
        const created = await link.agent.request(methods.agent.session.new, {
          ...(create as object),
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
          _meta: {
            ...((create as { _meta?: object })?._meta ?? {}),
            ...trust,
            [META.sessionId]: session.id,
          },
        } as never);
        return { link, created };
      }
      session.resuming = true;
      let resumed: unknown;
      try {
        // What the session was made with goes again: the agent does not keep it across a restart.
        const { additionalDirectories, systemPrompt } = session.entry;
        resumed = await link.agent.request(methods.agent.session.resume, {
          sessionId: session.entry.agentSessionId,
          cwd: session.entry.cwd,
          ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          _meta: {
            ...trust,
            // So that an agent that finds no record of a session that had turns says so.
            ...(session.entry.hadTurn === true ? { [META.hadTurn]: true } : {}),
          },
        } as never);
      } catch (error) {
        throw new RpcError(CycleErrorCode.ResumeFailed, "The agent could not resume the session", {
          sessionId: session.id,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        session.resuming = false;
      }
      // A setting not on record (a session older than the record of what it started with) is
      // whatever the agent resumed it in: on record from now, so a client can show it.
      const resumedWith = currentValues(
        (resumed as { configOptions?: unknown } | undefined)?.configOptions,
      );
      const missing = Object.fromEntries(
        Object.entries(resumedWith).filter(([key]) => !(key in (session.entry.config ?? {}))),
      );
      if (Object.keys(missing).length > 0) {
        this.#remember(session, { config: { ...missing, ...(session.entry.config ?? {}) } });
      }
      // What was saved is put back, setting by setting. One the agent no longer takes is not left on
      // record as if it were in force: the session carries on with what the agent actually has, the
      // record says so, and the conversation says so before anything more is sent.
      const refused: { configId: string; wanted: string }[] = [];
      for (const [configId, value] of Object.entries(session.entry.config ?? {})) {
        await link.agent
          .request(methods.agent.session.setConfigOption, {
            sessionId: session.entry.agentSessionId,
            configId,
            type: "id",
            value,
          } as never)
          .catch((error: unknown) => {
            // Only the agent's own answer is a refusal. A link that broke is not: the record is kept.
            if (typeof (error as { code?: unknown } | null)?.code === "number")
              refused.push({ configId, wanted: value });
          });
      }
      if (refused.length > 0) await this.#configNotRestored(session, refused, resumedWith);
      return { link, created: undefined };
    } catch (error) {
      session.link = undefined;
      this.#connectors.release(session.id);
      link.kill();
      throw error;
    }
  }

  /**
   * Settings the agent refused on resume: the record follows what is in force, and the conversation
   * says so. Written before the caller can send anything more.
   */
  async #configNotRestored(
    session: Session,
    refused: { configId: string; wanted: string }[],
    actual: Record<string, string>,
  ): Promise<void> {
    const config = { ...(session.entry.config ?? {}) };
    // An agent that listed none of its settings has not said what is in force: the record stays as it is.
    const known = Object.keys(actual).length > 0;
    const titles: string[] = [];
    for (const { configId, wanted } of refused) {
      const now = actual[configId];
      if (now !== undefined) {
        config[configId] = now;
        titles.push(`The agent did not accept "${wanted}" for "${configId}". It is now "${now}".`);
      } else if (known) {
        delete config[configId];
        titles.push(
          `The agent no longer has the setting "${configId}" (it was "${wanted}"). It is not applied.`,
        );
      } else {
        titles.push(
          `The agent did not accept "${wanted}" for "${configId}", and has not said what it is now.`,
        );
      }
    }
    // The record first, and waited for, so a client that sees the notice finds the list already right.
    session.entry = { ...session.entry, config };
    await this.#index.update(session.id, { config });
    this.#changed();
    for (const title of titles) {
      await this.#write(session, {
        kind: "update",
        data: { sessionUpdate: "notice", severity: "warning", title },
      });
    }
  }

  /** The agent for a session, started if it is not running. */
  async #ensureAgent(session: Session): Promise<AgentLink> {
    if (session.link !== undefined) return session.link;
    session.starting ??= this.#startAgent(session, "resume")
      .then(({ link }) => link)
      .finally(() => {
        session.starting = undefined;
      });
    return session.starting;
  }

  #onUpdate(session: Session, update: SessionUpdate): void {
    if (session.resuming || session.historyError !== undefined) return;
    const state = update as { sessionUpdate: string; state?: string };
    if (state.sessionUpdate === "state_update" && typeof state.state === "string") {
      if (
        state.state === "running" ||
        state.state === "idle" ||
        state.state === "requires_action"
      ) {
        session.agentState = state.state;
      }
    }
    if (!this.#learn(session, update)) return;
    // Called in the order the updates arrive, so seq follows the agent's order.
    // The list shows what a session is doing, not what it said: only a change of state is announced
    // (docs/protocol.md §6). Anything else that changes the list says so where it changes it.
    const announce = state.sessionUpdate === "state_update";
    void this.#write(session, { kind: "update", data: update }).then((written) => {
      if (written && announce) this.#changed();
    });
    // A turn ended (an idle that says why, not a snapshot): the next prompt goes, or the queue is handed back.
    const ended = update as { sessionUpdate: string; state?: string; stopReason?: unknown };
    if (
      ended.sessionUpdate === "state_update" &&
      ended.state === "idle" &&
      typeof ended.stopReason === "string" &&
      session.queue.length > 0
    ) {
      if (ended.stopReason === "end_turn") this.#dispatchNext(session);
      else
        void this.#returnQueue(session, ended.stopReason === "cancelled" ? "cancelled" : "error");
    }
    // A turn that ended with nothing behind it: an agent started with an old trust decision can go now.
    if (
      ended.sessionUpdate === "state_update" &&
      ended.state === "idle" &&
      typeof ended.stopReason === "string"
    )
      this.#restartIfStale(session);
  }

  // ---- the queue (docs/protocol.md §8) ----

  /** The queue as the last snapshot in a log left it. */
  async #queueIn(log: SessionLog): Promise<QueueEntry[]> {
    const records = await log.read();
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      if (record?.kind !== "update") continue;
      const parsed = QueueUpdateSchema.safeParse(record.data);
      if (parsed.success) return parsed.data.entries;
    }
    return [];
  }

  /**
   * Writes the queue as it is now, with what was handed back by this change, if anything. Whether
   * it is on record: a change a person asked for is confirmed to them only once it is.
   */
  #publishQueue(
    session: Session,
    back?: { returned: QueueEntry[]; reason: QueueReason },
  ): Promise<boolean> {
    const queued = session.queue.length > 0;
    if ((session.entry.queued === true) !== queued) {
      this.#remember(session, { queued: queued ? true : undefined } as Partial<SessionEntry>);
    }
    return this.#write(session, {
      kind: "update",
      data: {
        sessionUpdate: QUEUE_UPDATE,
        entries: [...session.queue],
        ...(back !== undefined ? back : {}),
      },
    }).then((written) => {
      if (written) this.#changed();
      return written;
    });
  }

  /**
   * Hands everything waiting back, to be put in the input box. Nothing is sent. A client acts on
   * what is handed back only when it is there to be told, so with no client attached the queue
   * stays, and is handed back, for the same reason, when one attaches. `force` is for that.
   */
  #returnQueue(session: Session, reason: QueueReason, force = false): void {
    if (session.queue.length === 0 || this.#closing) return;
    if (!force && session.attachments.size === 0) {
      session.heldReason ??= reason;
      return;
    }
    const returned = session.queue;
    session.queue = [];
    session.heldReason = undefined;
    // It is on record, but no one is attached to take it from there (a client that reads a history ignores what was
    // handed back in it): kept, to be handed back live to the first that attaches.
    if (session.attachments.size === 0)
      session.unclaimed = {
        returned: [...(session.unclaimed?.returned ?? []), ...returned],
        // The first reason stands for what was kept first: it is the oldest that no one has taken.
        reason: session.unclaimed?.reason ?? reason,
      };
    this.#publishQueue(session, { returned, reason });
  }

  /** What was handed back to no one is handed back to the client that has attached now, as if live. */
  #handBackUnclaimed(session: Session): void {
    const { unclaimed } = session;
    if (unclaimed === undefined || session.attachments.size === 0) return;
    session.unclaimed = undefined;
    this.#publishQueue(session, unclaimed);
  }

  /** A queue left behind with no turn to send it: the reason it was held, or a restart's. */
  #returnStale(session: Session): void {
    const status = session.status();
    if (status !== "idle" && status !== "stopped") return;
    this.#returnQueue(session, session.heldReason ?? "interrupted", true);
  }

  /** The oldest queued prompt goes to the agent, as the turn before it ended well. */
  #dispatchNext(session: Session): void {
    const next = session.queue.shift();
    if (next === undefined) return;
    this.#publishQueue(session);
    session.agentState = "running";
    // A new turn: its end, or its failure, is to be put on record (the one before left this set).
    session.turnEnded = false;
    this.#send(session, next.prompt).catch((error: unknown) => {
      this.#promptFailed(session, error);
      // It did not go, and what was behind it must not go past it: all of it is handed back, in order.
      session.queue.unshift(next);
      this.#returnQueue(session, "error");
    });
  }

  /** A prompt that could not be given to the agent: a turn that ended in failure is a turn end like any other, on record, so the session shows as unread. */
  #promptFailed(session: Session, error: unknown): void {
    session.agentState = "idle";
    this.#changed();
    const code = (error as { code?: unknown } | null)?.code;
    this.#endTurnWithError(
      session,
      typeof code === "number" ? code : INTERNAL_ERROR,
      error instanceof Error ? error.message : String(error),
    );
  }

  /** Gives a prompt to the agent, starting it if it is not running. */
  /**
   * Hands a prompt to the turn that is running (docs/protocol.md §8). Undefined when the agent
   * cannot take it (it does not steer, it is not there, or it refused, as when the turn has just
   * ended): the caller queues it, or sends it, as the session now is.
   */
  async #steer(session: Session, prompt: unknown[]): Promise<unknown> {
    const link = session.link;
    if (this.#definition(session.entry.agent).steer !== true || link === undefined) return;
    try {
      const answer = (await link.agent.request(methods.agent.session.prompt, {
        sessionId: session.entry.agentSessionId,
        prompt,
        _meta: { [META.steer]: true },
      } as never)) as { messageId?: unknown; _meta?: Record<string, unknown> | null };
      return { ...answer, _meta: { ...(answer._meta ?? {}), [META.steered]: true } };
    } catch {
      return undefined;
    }
  }

  async #send(session: Session, prompt: unknown[]): Promise<unknown> {
    const stopsBefore = session.startingCancels;
    const link = await this.#ensureAgent(session);
    if (session.startingCancels !== stopsBefore) {
      // Stopped while the agent was starting: there is no turn to stop yet, so the prompt is not given.
      // The turn ends as a cancelled one, which clients and the queue see like any other.
      this.#onUpdate(session, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
      } as SessionUpdate);
      return { messageId: randomUUID() };
    }
    return link.agent.request(methods.agent.session.prompt, {
      sessionId: session.entry.agentSessionId,
      prompt,
    } as never);
  }

  /**
   * Appends to a session's log. A write that fails is not lost quietly: the session is marked,
   * clients are told by a path that does not go through the log, and false is returned.
   */
  async #write(session: Session, record: NewRecord): Promise<boolean> {
    // Once it has failed nothing more is written: what comes after a gap would not be the history.
    if (session.historyError !== undefined || session.closed) return false;
    try {
      // What is kept, and so what clients see, is what has been through this (docs/protocol.md §12).
      const data = checkToolResult(record.kind, redactRecord(record.kind, record.data));
      await session.log.append({ ...record, data });
      return true;
    } catch (error) {
      // A log that was closed on purpose (the session is deleted, the daemon stops) is not a failure.
      if (!session.closed) this.#historyFailed(session, error);
      return false;
    }
  }

  /**
   * The history cannot be written. What happens next would not be on record, so the turn is
   * stopped (the agent is cancelled, what it waits on is answered as cancelled), every client
   * attached is told, and no new turn starts until the daemon is started again.
   */
  #historyFailed(session: Session, error: unknown): void {
    if (session.historyError !== undefined) return;
    session.historyError = error instanceof Error ? error.message : String(error);
    for (const pending of [...session.pending.values()]) {
      pending.settled = true;
      session.pending.delete(pending.requestId);
      pending.resolve(pending.cancelled);
      for (const attachment of pending.asked) {
        void attachment.conn
          .notify(NOTIFICATIONS.requestResolved, {
            sessionId: session.id,
            requestId: pending.requestId,
            outcome: pending.cancelled,
          })
          .catch(() => {});
      }
    }
    session.agentState = "idle";
    void session.link?.agent
      .notify(methods.agent.session.cancel, { sessionId: session.entry.agentSessionId } as never)
      .catch(() => undefined);
    // Not logged: the log is what failed. Like a snapshot it carries no seq.
    const update = {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: { code: CycleErrorCode.LogUnavailable, message: HISTORY_NOT_SAVED },
    };
    for (const attachment of session.attachments) {
      void attachment.conn
        .notify(SESSION_UPDATE, { sessionId: session.id, update })
        .catch(() => {});
    }
    this.#changed();
  }

  /**
   * A crash can cost a log its last, half-written line, and with it the seqs after it, which are
   * then given out again. A mark made in the index for one of those would hide the new records of
   * the same number: it never stands past the log's end.
   */
  #clamp(session: Session): void {
    const last = session.log.lastSeq();
    const patch: Partial<SessionEntry> = {};
    if ((session.entry.readSeq ?? 0) > last) patch.readSeq = last;
    if ((session.entry.attentionSeq ?? 0) > last) patch.attentionSeq = last;
    if (Object.keys(patch).length > 0) this.#remember(session, patch, false);
  }

  /** Follows what is written to a session's log, for what the list shows of it. */
  #watch(session: Session): void {
    session.log.subscribe((record) => this.#observe(session, record));
  }

  #observe(session: Session, record: LogRecord): void {
    // A request put to the owner (a permission, a form) is worth seeing whatever the agent says of
    // its own state: the Claude adapter says nothing, and the daemon knows it is waiting.
    if (record.kind === "request") {
      this.#remember(session, { attentionSeq: record.seq });
      return;
    }
    if (record.kind !== "update") return;
    const update = record.data as Record<string, unknown>;
    // The person's first message: from now on the session is in the list.
    if (update.sessionUpdate === "user_message" && session.entry.prompted !== true) {
      this.#remember(session, { prompted: true });
      return;
    }
    if (update.sessionUpdate === "state_update") {
      // Worth seeing: the agent waits on the owner, or a turn has ended (an idle that says why: the
      // one the agent sends on resume is a snapshot, not an end). See docs/protocol.md §6.
      if (
        update.state === "requires_action" ||
        (update.state === "idle" && update.stopReason !== undefined)
      ) {
        // `#onUpdate` announces a change of state once the record is written: not twice.
        this.#remember(session, { attentionSeq: record.seq }, false);
        // A turn that has already been followed by the next (a queued prompt goes as the idle is written) is not the ended one.
        if (update.state === "idle") session.turnEnded = session.agentState === "idle";
      }
    } else if (update.sessionUpdate === "subagent_update") {
      if (session.noteSubagent(update)) {
        this.#changed();
        this.#restartIfStale(session);
      }
    }
  }

  /**
   * What an update tells the daemon about the session, beyond what it tells the client. Returns
   * false for an update that must not reach the log: an agent title the user has overruled, or one
   * the log already has.
   */
  #learn(session: Session, update: SessionUpdate): boolean {
    const u = update as {
      sessionUpdate: string;
      state?: string;
      stopReason?: string;
      title?: string | null;
      configOptions?: { configId?: string; currentValue?: unknown }[];
    };
    if (
      u.sessionUpdate === "state_update" &&
      u.state === "idle" &&
      u.stopReason === "end_turn" &&
      session.entry.hadTurn !== true
    ) {
      // A turn that was answered: the agent has a record of the session now. (A turn that failed, or was
      // cut off, may never have reached it; those prove nothing.)
      this.#remember(session, { hadTurn: true }, false);
    } else if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) {
      // The agent changed a setting itself (a plan approved, say): on record, so a restart keeps it.
      const config = { ...(session.entry.config ?? {}), ...currentValues(u.configOptions) };
      this.#remember(session, { config });
    } else if (u.sessionUpdate === "usage_update") {
      const usage = SessionUsageSchema.safeParse(update);
      if (usage.success) {
        const { cost, ...rest } = usage.data;
        this.#remember(session, { usage: { ...rest, ...(cost ? { cost } : {}) } });
      }
    } else if (u.sessionUpdate === "session_info_update") {
      // The user's own name for a session wins over the agent's: a title that is not marked as the
      // agent's is the user's, which includes every title written before agents named sessions.
      const { title, titleFromAgent } = session.entry;
      // An agent that starts again says its title again: once is enough (if that is all it says).
      const said = Object.keys(update).filter((key) => key !== "sessionUpdate" && key !== "title");
      if (u.title === title && titleFromAgent === true && said.length === 0) return false;
      if (
        typeof u.title === "string" &&
        u.title !== "" &&
        (title === undefined || titleFromAgent === true)
      ) {
        this.#remember(session, { title: u.title, titleFromAgent: true });
      } else if (typeof u.title === "string") {
        // The user named it: clients are not told a different name, here or in a replay.
        return false;
      }
    }
    return true;
  }

  #remember(session: Session, patch: Partial<SessionEntry>, announce = true): void {
    session.entry = { ...session.entry, ...patch };
    // A session that is still being made is not in the index yet; it is put there with this entry.
    if (this.#index.get(session.id) === undefined) return;
    void this.#index.update(session.id, patch).then(
      () => {
        if (announce) this.#changed();
      },
      () => undefined,
    );
  }

  /** Puts a request to the clients, waits for the answer, and writes the request to the log. */
  async #ask(
    session: Session,
    method: string,
    params: Record<string, unknown>,
    how: { cancelled: unknown; answer: (response: unknown) => unknown },
  ): Promise<unknown> {
    const requestId = session.nextRequestId();
    // The id is in _meta so a client can match `_cycle/request_resolved` to the dialog it is showing.
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    // What a client is shown has been through the same filter as what is kept: it is not the log that sends this.
    const clientParams = {
      ...redactParams(params),
      sessionId: session.id,
      _meta: { ...meta, [META.requestId]: requestId },
    };
    let resolve: (outcome: unknown) => void = () => {};
    const outcome = new Promise<unknown>((r) => {
      resolve = r;
    });
    const pending: Pending = {
      requestId,
      method,
      cancelled: how.cancelled,
      answer: how.answer,
      params: clientParams,
      settled: false,
      asked: new Set(),
      resolve,
    };
    session.pending.set(requestId, pending);
    // Delivery is by the log: attached clients get it as the record is written. A request that
    // could not be written was shown to no one: the agent is told it was cancelled.
    const written = await this.#write(session, {
      kind: "request",
      data: { requestId, method, params: clientParams },
    });
    if (!written) {
      pending.settled = true;
      session.pending.delete(requestId);
      return how.cancelled;
    }
    // A request written while nobody is attached waits here until a client attaches.
    return outcome;
  }

  async #onPermission(session: Session, params: Record<string, unknown>): Promise<unknown> {
    const outcome = await this.#ask(session, REQUEST_PERMISSION, params, {
      cancelled: { outcome: "cancelled" },
      answer: (response) => (response as { outcome: unknown }).outcome,
    });
    return { outcome };
  }

  /**
   * The agent asks for a form (docs/protocol.md §9, decision 0011). Only a client that said it can
   * answer one is asked, and if none is attached the agent is told so at once instead of waiting:
   * a question is not worth holding a turn for, and a client without the screen would never answer.
   */
  async #onElicitation(session: Session, params: Record<string, unknown>): Promise<unknown> {
    if (!this.#canAskForms(session)) return { action: "cancel", _meta: { [META.noClient]: true } };
    return this.#ask(session, ELICITATION, params, {
      cancelled: { action: "cancel" },
      answer: elicitationAnswer,
    });
  }

  /** Asks one client, once. The first answer from any client settles it. */
  #offer(session: Session, pending: Pending, attachment: Attachment): void {
    if (pending.settled || pending.asked.has(attachment)) return;
    if (pending.method === ELICITATION && !attachment.conn.elicitation) return;
    pending.asked.add(attachment);
    attachment.conn
      .request(pending.method, pending.params)
      .then((answer) => this.#settle(session, pending, pending.answer(answer), attachment))
      .catch(() => {
        pending.asked.delete(attachment);
        // A client that cannot answer a form (its handler failed, or it went) is not going to: when
        // no other client has it, the agent is told so, as with no client at all (decision 0011).
        if (pending.method === ELICITATION && pending.asked.size === 0) {
          this.#settle(session, pending, { action: "cancel", _meta: { [META.noClient]: true } });
        }
      });
  }

  #settle(session: Session, pending: Pending, outcome: unknown, by?: Attachment): void {
    if (pending.settled) return;
    pending.settled = true;
    session.pending.delete(pending.requestId);
    // The session is no longer waiting on the owner: the list says so (the agent may say nothing).
    this.#changed();
    // What a person typed into a form can be a password or a token: the agent gets all of it, the
    // log and the other clients get that it was answered, and how.
    const shown = pending.method === ELICITATION ? withoutContent(outcome) : outcome;
    // The agent gets the answer once the answer is on record: a permission it was given that the
    // history does not show is worse than none. If the record cannot be written, it is told no.
    void this.#write(session, {
      kind: "response",
      data: { requestId: pending.requestId, outcome: shown, by: by?.conn.id ?? "daemon" },
    }).then((written) => {
      const given = written ? outcome : pending.cancelled;
      const told = written ? shown : pending.cancelled;
      pending.resolve(given);
      for (const other of pending.asked) {
        if (other === by) continue;
        void other.conn
          .notify(NOTIFICATIONS.requestResolved, {
            sessionId: session.id,
            requestId: pending.requestId,
            outcome: told,
          })
          .catch(() => {});
      }
    });
  }

  /**
   * A turn that ended in failure the agent did not report (it exited, or the prompt could not be sent) is put on record
   * as the end of the turn, once: that record is what makes the session unread. The list is announced again after it
   * is written, because a client that re-lists on the first announcement reads the row before the mark.
   */
  #endTurnWithError(session: Session, code: number, message: string): void {
    if (session.turnEnded) return;
    session.turnEnded = true;
    void this.#write(session, {
      kind: "update",
      data: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "error",
        error: { code, message },
      },
    }).then((written) => {
      if (written) this.#changed();
    });
  }

  #onAgentClosed(session: Session, link: AgentLink | undefined): void {
    if (session.link !== link && link !== undefined) return;
    const wasWorking = session.agentState !== "idle";
    session.link = undefined;
    // Its key to the gateway goes with it, and the connector processes it had.
    this.#connectors.release(session.id);
    for (const pending of [...session.pending.values()]) {
      pending.settled = true;
      session.pending.delete(pending.requestId);
      void this.#write(session, { kind: "aborted", data: { requestId: pending.requestId } });
      pending.resolve(pending.cancelled);
      for (const attachment of pending.asked) {
        void attachment.conn
          .notify(NOTIFICATIONS.requestResolved, {
            sessionId: session.id,
            requestId: pending.requestId,
            outcome: pending.cancelled,
          })
          .catch(() => {});
      }
    }
    void this.#write(session, { kind: "meta", data: { event: "agent_exited" } });
    // The sub-agents went with the process. The list is announced as changed at the end.
    session.endSubagents();
    if (wasWorking) {
      // Whoever is watching is told the turn is over, rather than left waiting for an idle.
      session.agentState = "idle";
      this.#endTurnWithError(session, CycleErrorCode.AgentExited, "The agent exited");
    }
    // What waits for an agent that is gone is handed back, after the idle that says why.
    this.#returnQueue(session, "error");
    this.#changed();
  }

  // ---- what a client sees ----

  #deliver(session: Session, attachment: Attachment) {
    return async (record: LogRecord) => {
      if (record.kind === "update") {
        await attachment.conn.notify(SESSION_UPDATE, {
          sessionId: session.id,
          update: record.data,
          _meta: { [META.seq]: record.seq },
        });
      } else if (record.kind === "request") {
        const id = (record.data as { requestId: string }).requestId;
        const pending = session.pending.get(id);
        if (pending !== undefined) this.#offer(session, pending, attachment);
      }
    };
  }

  /**
   * A session's row in the list, or undefined for one the person has not yet written to: a new session is a blank
   * conversation in the client until its first message, and only then is it in the list (docs/protocol.md §6).
   */
  async #row(sessionId: string, entry: SessionEntry, onlyPrompted: boolean) {
    const session = await this.#session(sessionId);
    // One whose history has failed is listed whatever it holds: the list is where it is deleted from.
    if (onlyPrompted && session.historyError === undefined && !(await this.#prompted(session)))
      return undefined;
    const background = session.backgroundCount();
    return {
      sessionId,
      cwd: entry.cwd,
      updatedAt: session.updatedAt(),
      _meta: {
        [META.archived]: entry.archived === true,
        [META.agent]: entry.agent,
        [META.state]: session.status(),
        [META.lastSeq]: session.log.lastSeq(),
        [META.unread]: session.unread(),
        ...(background > 0 ? { [META.background]: background } : {}),
        ...(session.historyError !== undefined ? { [META.historyFailed]: true } : {}),
        ...(entry.config !== undefined ? { [META.config]: entry.config } : {}),
        ...(entry.usage !== undefined ? { [META.usage]: entry.usage } : {}),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
      },
    };
  }

  /**
   * Whether the person has said anything in the session. Known from the index, or for an entry written before the index
   * kept it, read once from the log and kept. A log that cannot be read throws, and the session is listed as unreadable.
   */
  async #prompted(session: Session): Promise<boolean> {
    if (session.entry.prompted !== undefined) return session.entry.prompted;
    // As stored: an image is not read back from its blob to find out whether there is a message.
    const records = await session.log.read(undefined, { stored: true });
    const prompted = records.some(isUserMessage);
    // A message written while the log was being read has set it already.
    if (session.entry.prompted === undefined) this.#remember(session, { prompted }, false);
    return session.entry.prompted ?? prompted;
  }

  /**
   * A session whose history cannot be read, as the list shows it: what the index knows, with no
   * `cycle/lastSeq` (that comes from the log) and no unread mark, and the marker.
   */
  #unreadableRow(sessionId: string, entry: SessionEntry) {
    return {
      sessionId,
      cwd: entry.cwd,
      updatedAt: entry.createdAt,
      _meta: {
        [META.archived]: entry.archived === true,
        [META.agent]: entry.agent,
        [META.state]: "stopped",
        [META.historyFailed]: true,
        ...(entry.config !== undefined ? { [META.config]: entry.config } : {}),
        ...(entry.usage !== undefined ? { [META.usage]: entry.usage } : {}),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
      },
    };
  }

  /** The app a client talks to: this connection's view of the daemon. */
  #facing(holder: { value?: ClientConn }) {
    const me = (): ClientConn => {
      if (holder.value === undefined) throw new Error("connection not ready");
      return holder.value;
    };
    const app = acpAgent({ name: "cycle" });

    app.onRequest(methods.agent.initialize, async ({ params }) => {
      const requested = (params._meta as Record<string, unknown> | null | undefined)?.[
        META.protocolVersion
      ];
      // Whether this client can answer a form: only then is it asked one (decision 0011).
      me().elicitation = params.capabilities?.elicitation?.form != null;
      if (
        typeof requested === "string" &&
        requested.split(".")[0] !== CYCLE_PROTOCOL_VERSION.split(".")[0]
      ) {
        throw new RpcError(UNSUPPORTED_VERSION, "Unsupported Cycle protocol version", {
          supported: [CYCLE_PROTOCOL_VERSION],
          requested,
        });
      }
      return {
        protocolVersion: 2,
        info: { name: "cycle", version: this.#version },
        capabilities: { session: {} },
        _meta: {
          [META.protocolVersion]: CYCLE_PROTOCOL_VERSION,
          [META.capabilities]: {
            replay: ["start", "_cycle.seq"],
            agents: [...this.#agents.keys()],
            sessionOps: ["archive", "rename", "delete", "markRead"],
            queue: true,
            steer: true,
            files: true,
            folders: true,
            filesInFolder: true,
            trust: true,
            connectors: true,
          },
        },
      } as never;
    });

    app.onRequest(methods.agent.session.new, async ({ params }) => {
      const meta = (params._meta ?? {}) as Record<string, unknown>;
      const agentId =
        typeof meta[META.agent] === "string"
          ? (meta[META.agent] as string)
          : [...this.#agents.keys()][0];
      if (agentId === undefined)
        throw new RpcError(CycleErrorCode.AgentUnavailable, "No agent is configured");
      this.#definition(agentId);
      // The directories are paths on THIS machine (the daemon's), not the client's. Say so up front.
      const directories = [params.cwd, ...(params.additionalDirectories ?? [])];
      for (const [index, directory] of directories.entries()) {
        if (!isAbsolute(directory)) {
          throw new RpcError(
            INVALID_PARAMS,
            `The ${index === 0 ? "working directory" : "directory"} ${directory} is not an absolute path`,
          );
        }
        if (
          !(await stat(directory).then(
            (s) => s.isDirectory(),
            () => false,
          ))
        )
          throw new RpcError(
            INVALID_PARAMS,
            `The ${index === 0 ? "working directory" : "directory"} ${directory} does not exist on the machine the daemon runs on`,
          );
      }
      const id = randomUUID();
      const entry: SessionEntry = {
        agent: agentId,
        agentSessionId: id,
        cwd: params.cwd,
        createdAt: new Date().toISOString(),
        // Not in the list until the person's first message is on record (docs/protocol.md §6).
        prompted: false,
        // Kept to send again each time the agent starts. Not in the log: that goes to every client.
        ...(params.additionalDirectories?.length
          ? { additionalDirectories: params.additionalDirectories }
          : {}),
        ...(params.mcpServers?.length ? { mcpServers: params.mcpServers } : {}),
        ...(params.systemPrompt != null ? { systemPrompt: params.systemPrompt } : {}),
      };
      const log = await this.#store.open(id);
      const session = new Session(id, entry, log);
      this.#watch(session);
      try {
        await log.append({
          kind: "meta",
          data: { event: "created", agent: agentId, cwd: params.cwd },
        });
        const { created } = await this.#startAgent(session, "new", {
          cwd: params.cwd,
          additionalDirectories: params.additionalDirectories,
          mcpServers: params.mcpServers,
          systemPrompt: params.systemPrompt,
        });
        const answer = created as { sessionId: string; configOptions?: unknown[] };
        session.entry = { ...session.entry, agentSessionId: answer.sessionId };
        // The agent may have taken our id or kept its own; either way the pair is on record.
        await this.#index.put(id, session.entry);
        this.#sessions.set(id, session);
        // What the user set as the agent's defaults, then what they asked of this one.
        const config = { ...this.#defaults.get(agentId), ...stringConfig(meta[META.config]) };
        // What the agent says its settings are now: each change answers with the whole set.
        let options = answer.configOptions ?? [];
        for (const [configId, value] of Object.entries(config)) {
          try {
            const changed = await session.link?.agent.request(
              methods.agent.session.setConfigOption,
              {
                sessionId: session.entry.agentSessionId,
                configId,
                type: "id",
                value,
              } as never,
            );
            const latest = (changed as { configOptions?: unknown[] } | undefined)?.configOptions;
            if (Array.isArray(latest) && latest.length > 0) options = latest;
          } catch (error) {
            throw new RpcError(
              CycleErrorCode.InvalidConfig,
              "The agent refused the configuration",
              {
                configId,
                detail: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        // On record with what the agent started in, not only what was set: a resume sends it again,
        // so a session keeps its mode even if the agent's default for new ones changes. What the
        // agent reported meanwhile (a mode it fell back to) is newer than its first answer.
        const recorded = {
          ...currentValues(options),
          ...(session.entry.config ?? {}),
          ...config,
        };
        if (Object.keys(recorded).length > 0) {
          session.entry = { ...session.entry, config: recorded };
          await this.#index.update(id, { config: recorded });
        }
        this.#changed();
        this.#letGoOfOldestAhead(session);
        return { sessionId: id, configOptions: options } as never;
      } catch (error) {
        session.closed = true;
        session.link?.kill();
        this.#sessions.delete(id);
        await log.close();
        await this.#index.delete(id).catch(() => undefined);
        await this.#store.remove(id).catch(() => undefined);
        throw error;
      }
    });

    app.onRequest(methods.agent.session.list, async ({ params }) => {
      // Only a client that asks leaves out the sessions nothing has been said in: an older one opens a session it has
      // just made by finding it in the list (docs/protocol.md §6).
      const said =
        (params?._meta as Record<string, unknown> | null | undefined)?.[META.onlyPrompted] === true;
      const rows = [];
      for (const [sessionId, entry] of this.#index.list()) {
        try {
          const row = await this.#row(sessionId, entry, said);
          if (row !== undefined) rows.push(row);
        } catch (error) {
          // Deleted while the list was being read.
          if (error instanceof RpcError && error.code === RESOURCE_NOT_FOUND) continue;
          // One session whose history cannot be read is that session's problem, not the list's: it
          // is listed, marked, and says so when it is opened. Anything else is the list's.
          if (!(error instanceof RpcError) || error.code !== CycleErrorCode.LogUnavailable)
            throw error;
          rows.push(this.#unreadableRow(sessionId, entry));
        }
      }
      return { sessions: rows } as never;
    });

    app.onRequest(methods.agent.session.resume, async ({ params }) => {
      const session = await this.#session(params.sessionId);
      const raw = params.replayFrom as { type?: string } | null | undefined;
      let after = session.log.lastSeq();
      let replaying = false;
      if (raw !== undefined && raw !== null) {
        replaying = true;
        if (raw.type === "start") after = 0;
        else if (raw.type === "_cycle.seq") {
          const parsed = ReplayFromSeqSchema.safeParse(raw);
          if (!parsed.success)
            throw new RpcError(INVALID_PARAMS, "Bad replayFrom", { replayFrom: raw });
          after = parsed.data.after;
        } else throw new RpcError(INVALID_PARAMS, "Unknown replayFrom", { replayFrom: raw });
      }
      const conn = me();
      for (const old of session.attachments) {
        if (old.conn === conn) {
          old.detach();
          session.attachments.delete(old);
        }
      }
      const attachment: Attachment = { conn, detach: () => {} };
      session.attachments.add(attachment);
      const deliver = this.#deliver(session, attachment);
      try {
        const { detach } = await attach(session.log, after, deliver, async (replayedTo) => {
          // ACP v2: the replay is ended by one replay_complete, then the current state.
          if (replaying) {
            await conn.notify(SESSION_UPDATE, {
              sessionId: session.id,
              update: { sessionUpdate: "replay_complete" },
              _meta: { [META.seq]: replayedTo },
            });
          }
          await conn.notify(SESSION_UPDATE, { sessionId: session.id, update: session.snapshot() });
        });
        attachment.detach = detach;
      } catch (error) {
        session.attachments.delete(attachment);
        throw error;
      }
      // Requests still waiting from before are asked of this client too.
      for (const pending of session.pending.values()) this.#offer(session, pending, attachment);
      // A queue with no turn behind it was cut short by a restart. It is handed back now, after the
      // replay and the snapshot, so the client that attached is told while it is listening.
      this.#returnStale(session);
      this.#handBackUnclaimed(session);
      // Which they are, so a client that had one before can tell it is not among them: answered elsewhere.
      return {
        configOptions: [],
        _meta: {
          [META.pending]: [...session.pending.values()]
            .filter((pending) => pending.asked.has(attachment))
            .map((pending) => pending.requestId),
        },
      } as never;
    });

    app.onRequest(methods.agent.session.prompt, async ({ params }) => {
      const session = await this.#session(params.sessionId);
      // A turn that could not be written down is not started: it would be lost on the next restart.
      if (session.historyError !== undefined)
        throw logUnavailable(session.id, session.historyError);
      // Refused whole, before anything is started or written: a block is never dropped (decision 0010).
      const problem = checkPrompt(
        params.prompt,
        this.#definition(session.entry.agent).promptCapabilities,
      );
      if (problem !== undefined)
        throw new RpcError(INVALID_PARAMS, `The prompt cannot be sent: ${problem.reason}`, {
          sessionId: session.id,
          ...problem,
        });
      this.#returnStale(session);
      // Taken: from now on the session is in the list (docs/protocol.md §6), whatever the agent makes of it. Not left to
      // the agent's echo of the message, which an agent that fails, or never echoes, would not send. Announced below.
      if (session.entry.prompted !== true) this.#remember(session, { prompted: true }, false);
      const busy = () => session.status() !== "idle" && session.status() !== "stopped";
      const steer = (params._meta as Record<string, unknown> | null | undefined)?.[META.steer];
      if (busy() && steer === true) {
        // Into the running turn, where the agent can take it; otherwise it is queued as any other.
        const steered = await this.#steer(session, params.prompt);
        if (steered !== undefined) return steered as never;
      }
      if (busy()) {
        // The agent is busy: the prompt waits here, and goes when the turn ends well.
        if (session.queue.length >= QUEUE_LIMIT) throw queueFull(session.id, QUEUE_LIMIT);
        const queueId = randomUUID();
        const queued = { queueId, prompt: params.prompt };
        session.queue.push(queued);
        if (!(await this.#publishQueue(session))) {
          // Not on record, so not taken: the sender keeps what they wrote, and the queue is as it was.
          // (If the turn has ended meanwhile and sent it, it is gone from the queue and is not undone.)
          const at = session.queue.indexOf(queued);
          if (at >= 0) {
            session.queue.splice(at, 1);
            throw logUnavailable(session.id, session.historyError ?? HISTORY_NOT_SAVED);
          }
        }
        return { messageId: queueId, _meta: { [META.queued]: true } } as never;
      }
      // Marked at once: the agent's own "running" comes later, and a second prompt must not slip in.
      session.agentState = "running";
      session.turnEnded = false;
      this.#changed();
      try {
        return (await this.#send(session, params.prompt)) as never;
      } catch (error) {
        this.#promptFailed(session, error);
        // The prompt never reached the agent, so no turn will end to send or return what was queued behind it.
        this.#returnQueue(session, "error");
        throw error;
      }
    });

    app.onNotification(methods.agent.session.cancel, async ({ params }) => {
      const session = this.#sessions.get(params.sessionId);
      if (session === undefined) return;
      // ACP: every pending permission request is answered "cancelled" when a turn is cancelled.
      for (const pending of [...session.pending.values()])
        this.#settle(session, pending, pending.cancelled);
      // A stop means the person wants to change direction: what waits goes back to the input box.
      this.#returnQueue(session, "cancelled");
      // The agent is still starting: it has no turn to stop, so what is about to be given to it is held back.
      if (session.starting !== undefined) session.startingCancels++;
      await session.link?.agent
        .notify(methods.agent.session.cancel, { sessionId: session.entry.agentSessionId } as never)
        .catch(() => undefined);
    });

    app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      const session = await this.#session(params.sessionId);
      const link = await this.#ensureAgent(session);
      const answer = await link.agent.request(methods.agent.session.setConfigOption, {
        ...params,
        sessionId: session.entry.agentSessionId,
      } as never);
      const value = "value" in params ? params.value : undefined;
      if (typeof value === "string") {
        const config = { ...(session.entry.config ?? {}), [params.configId]: value };
        session.entry = { ...session.entry, config };
        await this.#index.update(session.id, { config });
        this.#changed();
      }
      return answer as never;
    });

    app.onRequest(methods.agent.session.close, async ({ params }) => {
      const session = this.#sessions.get(params.sessionId);
      if (session !== undefined) this.#returnQueue(session, "closed");
      session?.link?.kill();
      return {} as never;
    });

    app.onRequest(methods.agent.session.delete, async ({ params }) => {
      let session: Session;
      try {
        session = await this.#session(params.sessionId);
      } catch (error) {
        // A session whose history cannot be read can still be deleted: it is the way out of it.
        if (!(error instanceof RpcError) || error.code !== CycleErrorCode.LogUnavailable)
          throw error;
        try {
          await this.#index.delete(params.sessionId);
          await this.#store.remove(params.sessionId);
        } finally {
          this.#changed();
        }
        return {} as never;
      }
      if (session.status() === "running" || session.status() === "requires_action")
        throw sessionBusy(session.id);
      session.closed = true;
      session.link?.kill();
      for (const attachment of session.attachments) attachment.detach();
      try {
        // The index first, and the session out of the table at once: from then on nobody can load
        // it again or get hold of it (a list that was being read, a client that was reconnecting),
        // so none comes back from the dead while its log is being removed.
        await this.#index.delete(session.id);
        this.#sessions.delete(session.id);
        await session.log.close();
        await this.#store.remove(session.id);
      } finally {
        this.#changed();
      }
      return {} as never;
    });

    // The handler answers what the method's result schema says: a field the schema has and the handler leaves out
    // (or one of another shape) does not compile.
    const cycle = <P extends z.ZodType, R extends z.ZodType>(
      method: CycleMethod<P, R>,
      handler: (params: z.output<P>) => Promise<z.input<R>> | z.input<R>,
    ) => {
      app.onRequest(
        method.name as `_${string}`,
        method.params,
        async ({ params }) => (await handler(params as z.output<P>)) as never,
      );
    };

    cycle(agentsList, async () => ({
      agents: await Promise.all(
        [...this.#agents.values()].map(async (a) => ({
          id: a.id,
          name: a.name,
          available: (await a.available?.()) ?? true,
          configSchema: a.configSchema,
          ...(a.promptCapabilities !== undefined
            ? { promptCapabilities: a.promptCapabilities }
            : {}),
          ...(a.steer === true ? { steer: true } : {}),
        })),
      ),
    }));
    cycle(agentDefaultsRead, (params) => {
      this.#definition(params.agent);
      return { config: this.#defaults.get(params.agent) };
    });
    cycle(agentDefaultsSet, async (params) => {
      const definition = this.#definition(params.agent);
      // Only settings the agent says it has, when it says: a typo should not be saved and then ignored.
      const known = (definition.configSchema as { properties?: Record<string, unknown> })
        .properties;
      if (known !== undefined) {
        for (const [key, value] of Object.entries(params.config)) {
          if (!(key in known)) {
            throw new RpcError(CycleErrorCode.InvalidConfig, "The agent has no such setting", {
              agent: params.agent,
              configId: key,
            });
          }
          // A value the agent lists as the only ones it takes is checked now, not at the next new
          // session, which it would otherwise stop from being made.
          const choices = closedChoices(known[key]);
          if (choices !== undefined && !choices.includes(value)) {
            throw new RpcError(CycleErrorCode.InvalidConfig, "The agent has no such value", {
              agent: params.agent,
              configId: key,
              value,
              allowed: choices,
            });
          }
        }
      }
      await this.#defaults.set(params.agent, params.config as Record<string, string>);
      for (const conn of this.#conns) {
        void conn
          .notify(NOTIFICATIONS.agentDefaultsChanged, { agent: params.agent })
          .catch(() => {});
      }
      return {};
    });

    const change =
      (apply: (session: Session) => Promise<Partial<SessionEntry>>) =>
      async (params: { sessionId: string }) => {
        const session = await this.#session(params.sessionId);
        const patch = await apply(session);
        session.entry = { ...session.entry, ...patch };
        await this.#index.update(session.id, patch);
        this.#changed();
        return {};
      };
    cycle(promptDequeue, async (params) => {
      const session = await this.#session(params.sessionId);
      const at = session.queue.findIndex((entry) => entry.queueId === params.queueId);
      const [entry] = at < 0 ? [] : session.queue.splice(at, 1);
      if (entry === undefined) {
        throw new RpcError(CycleErrorCode.NotQueued, "That prompt is not waiting", {
          sessionId: session.id,
          queueId: params.queueId,
        });
      }
      if (!(await this.#publishQueue(session))) {
        // Not on record: the prompt stays where it was, and the person is told it did not come back.
        session.queue.splice(Math.min(at, session.queue.length), 0, entry);
        throw logUnavailable(session.id, session.historyError ?? HISTORY_NOT_SAVED);
      }
      return { prompt: entry.prompt };
    });
    cycle(filesSearch, async (params) => {
      // A conversation with no session yet looks in the folder it has chosen: the same search, the same bounds.
      let cwd: string;
      if (params.cwd !== undefined) {
        if (!isAbsolute(params.cwd) || params.cwd.includes("\0"))
          throw new RpcError(INVALID_PARAMS, "cwd must be an absolute path", { cwd: params.cwd });
        cwd = params.cwd;
      } else {
        cwd = (await this.#session(params.sessionId as string)).entry.cwd;
      }
      const found = await searchFiles(cwd, params.query, params.limit);
      return { root: cwd, ...found };
    });
    cycle(foldersList, (params) => listFolders(params.path, params.hidden === true));
    cycle(trustRead, async (params) => this.#trust.of(await realFolder(params.path)));
    cycle(trustSet, async (params) => {
      const real = await realFolder(params.path);
      const trust = await this.#trust.set(real, params.trusted);
      await this.#applyTrust(real);
      return trust;
    });
    cycle(connectorsList, async () => ({ connectors: await this.#connectors.list() }));
    cycle(connectorsAdd, async (params) => ({ connector: await this.#connectors.add(params) }));
    cycle(connectorsUpdate, async (params) => ({
      connector: await this.#connectors.update(params),
    }));
    cycle(connectorsRemove, async (params) => {
      await this.#connectors.remove(params.id);
      return {};
    });
    cycle(connectorsAuthStart, (params) =>
      this.#connectors.authStart(params.id, params.redirectUri),
    );
    cycle(connectorsAuthFinish, async (params) => ({
      connector: await this.#connectors.authFinish(params),
    }));
    cycle(connectorsAuthClear, async (params) => ({
      connector: await this.#connectors.authClear(params.id),
    }));
    cycle(sessionArchive, (params) =>
      change(async (session) => {
        if (session.status() === "running" || session.status() === "requires_action")
          throw sessionBusy(session.id);
        return { archived: true };
      })(params),
    );
    cycle(sessionUnarchive, (params) => change(async () => ({ archived: false }))(params));
    cycle(sessionMarkRead, async (params) => {
      const session = await this.#session(params.sessionId);
      const lastSeq = session.log.lastSeq();
      if (params.seq > lastSeq) {
        throw new RpcError(INVALID_PARAMS, "seq is past the session's last record", {
          sessionId: session.id,
          seq: params.seq,
          lastSeq,
        });
      }
      const before = session.entry.readSeq ?? 0;
      if (params.seq <= before) return {};
      const unread = session.unread();
      // On disk first: if that fails, what the list says and what a restart reads stay the same.
      // Decided in the index's queue, so a lower mark that arrives meanwhile cannot undo this one.
      await this.#index.update(session.id, (entry) => ({
        readSeq: Math.max(entry.readSeq ?? 0, params.seq),
      }));
      const readSeq = this.#index.get(session.id)?.readSeq ?? params.seq;
      session.entry = { ...session.entry, readSeq };
      if (session.unread() !== unread) this.#changed();
      return {};
    });
    cycle(sessionSetTitle, (params) =>
      change(async () => ({ title: params.title, titleFromAgent: false }))(params),
    );

    return app;
  }
}

/** A record of something the person said: the agent's echo of a prompt (docs/protocol.md §8). */
const isUserMessage = (record: LogRecord): boolean =>
  record.kind === "update" &&
  (record.data as { sessionUpdate?: unknown } | null)?.sessionUpdate === "user_message";
