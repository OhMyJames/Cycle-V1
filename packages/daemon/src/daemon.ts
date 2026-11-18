import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type AgentContext,
  agent as acpAgent,
  type ClientApp,
  methods,
  type SessionUpdate,
  type Stream,
} from "@cycle/acp";
import {
  agentDefaultsRead,
  agentDefaultsSet,
  agentsList,
  CYCLE_PROTOCOL_VERSION,
  CycleErrorCode,
  checkPrompt,
  META,
  NOTIFICATIONS,
  ReplayFromSeqSchema,
  SessionUsageSchema,
  sessionArchive,
  sessionMarkRead,
  sessionSetTitle,
  sessionUnarchive,
} from "@cycle/protocol";
import type { z } from "zod";
import { AgentLink } from "./agent-link.ts";
import type { AgentDefinition } from "./agents.ts";
import { blobsDir, defaultsPath, indexPath, sessionsDir } from "./data-dir.ts";
import { AgentDefaults } from "./defaults-file.ts";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  logUnavailable,
  RpcError,
  sessionBusy,
  sessionNotFound,
  UNSUPPORTED_VERSION,
} from "./errors.ts";
import { type SessionEntry, SessionIndex } from "./index-file.ts";
import { BlobLogStore } from "./log/blobs.ts";
import { JsonlLogStore } from "./log/jsonl.ts";
import { attach } from "./log/replay.ts";
import type { LogRecord, LogStore, NewRecord } from "./log/types.ts";
import {
  type Attachment,
  type ClientConn,
  HISTORY_NOT_SAVED,
  type Pending,
  Session,
} from "./session.ts";

export type DaemonOptions = {
  /** Where the daemon keeps its data. Always given: nothing here guesses a home. */
  dataDir: string;
  agents: AgentDefinition[];
  /** For tests: replaces the JSONL store. */
  store?: LogStore;
  /** What this build is, told to every client that connects. Default `dev`: not a release. */
  version?: string;
};

const SESSION_UPDATE = methods.client.session.update;
const REQUEST_PERMISSION = methods.client.session.requestPermission;
const ELICITATION = methods.client.elicitation.create;

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

export class Daemon {
  readonly #version: string;
  readonly #agents: Map<string, AgentDefinition>;
  readonly #store: LogStore;
  readonly #index: SessionIndex;
  readonly #defaults: AgentDefaults;
  readonly #sessions = new Map<string, Session>();
  /** Sessions being loaded, so a second request for one waits for the first load. */
  readonly #loading = new Map<string, Promise<Session>>();
  readonly #conns = new Set<ClientConn>();
  #counter = 0;

  private constructor(options: DaemonOptions, index: SessionIndex, defaults: AgentDefaults) {
    this.#version = options.version ?? "dev";
    this.#agents = new Map(options.agents.map((a) => [a.id, a]));
    this.#store =
      options.store ??
      new BlobLogStore(
        new JsonlLogStore({ dir: sessionsDir(options.dataDir) }),
        blobsDir(options.dataDir),
      );
    this.#index = index;
    this.#defaults = defaults;
  }

  /** Reads the index, and refuses to start if it is there and cannot be read. */
  static async start(options: DaemonOptions): Promise<Daemon> {
    return new Daemon(
      options,
      await SessionIndex.load(indexPath(options.dataDir)),
      await AgentDefaults.load(defaultsPath(options.dataDir)),
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
    for (const session of this.#sessions.values()) {
      session.closed = true;
      session.link?.kill();
      for (const attachment of session.attachments) attachment.detach();
      await session.log.close();
    }
    this.#sessions.clear();
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
    if (loaded !== undefined) return Promise.resolve(loaded);
    const loading = this.#loading.get(sessionId);
    if (loading !== undefined) return loading;
    const entry = this.#index.get(sessionId);
    if (entry === undefined) return Promise.reject(sessionNotFound(sessionId));
    const load = (async () => {
      const log = await this.#store.open(sessionId);
      const session = new Session(sessionId, entry, log);
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

  /** Starts the agent for a session and has it create or resume it. */
  async #startAgent(session: Session, mode: "new" | "resume", create?: Record<string, unknown>) {
    const definition = this.#definition(session.entry.agent);
    const link = await AgentLink.connect(definition, {
      update: (update) => this.#onUpdate(session, update),
      permission: (params) => this.#onPermission(session, params),
      elicitation: (params) => this.#onElicitation(session, params),
      closed: () => this.#onAgentClosed(session, link),
    });
    session.link = link;
    try {
      if (mode === "new") {
        const created = await link.agent.request(methods.agent.session.new, {
          ...(create as object),
          _meta: { ...((create as { _meta?: object })?._meta ?? {}), [META.sessionId]: session.id },
        } as never);
        return { link, created };
      }
      session.resuming = true;
      try {
        // What the session was made with goes again: the agent does not keep it across a restart.
        const { additionalDirectories, mcpServers, systemPrompt } = session.entry;
        await link.agent.request(methods.agent.session.resume, {
          sessionId: session.entry.agentSessionId,
          cwd: session.entry.cwd,
          ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        } as never);
      } catch (error) {
        throw new RpcError(CycleErrorCode.ResumeFailed, "The agent could not resume the session", {
          sessionId: session.id,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        session.resuming = false;
      }
      for (const [configId, value] of Object.entries(session.entry.config ?? {})) {
        await link.agent
          .request(methods.agent.session.setConfigOption, {
            sessionId: session.entry.agentSessionId,
            configId,
            type: "id",
            value,
          } as never)
          .catch(() => undefined);
      }
      return { link, created: undefined };
    } catch (error) {
      session.link = undefined;
      link.kill();
      throw error;
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
  }

  /**
   * Appends to a session's log. A write that fails is not lost quietly: the session is marked,
   * clients are told by a path that does not go through the log, and false is returned.
   */
  async #write(session: Session, record: NewRecord): Promise<boolean> {
    // Once it has failed nothing more is written: what comes after a gap would not be the history.
    if (session.historyError !== undefined || session.closed) return false;
    try {
      await session.log.append(record);
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
    if (update.sessionUpdate === "state_update") {
      // Worth seeing: the agent waits on the owner, or a turn has ended (an idle that says why: the
      // one the agent sends on resume is a snapshot, not an end). See docs/protocol.md §6.
      if (
        update.state === "requires_action" ||
        (update.state === "idle" && update.stopReason !== undefined)
      ) {
        // `#onUpdate` announces a change of state once the record is written: not twice.
        this.#remember(session, { attentionSeq: record.seq }, false);
        if (update.state === "idle") session.turnEnded = true;
      }
    } else if (update.sessionUpdate === "subagent_update") {
      if (session.noteSubagent(update)) this.#changed();
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
      title?: string | null;
      configOptions?: { configId?: string; currentValue?: unknown }[];
    };
    if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) {
      // The agent changed a setting itself (a plan approved, say): on record, so a restart keeps it.
      const config = { ...(session.entry.config ?? {}) };
      for (const option of u.configOptions) {
        if (typeof option.configId === "string" && typeof option.currentValue === "string") {
          config[option.configId] = option.currentValue;
        }
      }
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
    const clientParams = {
      ...params,
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

  async #row(sessionId: string, entry: SessionEntry) {
    const session = await this.#session(sessionId);
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
        for (const [configId, value] of Object.entries(config)) {
          try {
            await session.link?.agent.request(methods.agent.session.setConfigOption, {
              sessionId: session.entry.agentSessionId,
              configId,
              type: "id",
              value,
            } as never);
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
        if (Object.keys(config).length > 0) {
          session.entry = { ...session.entry, config };
          await this.#index.update(id, { config });
        }
        this.#changed();
        return { sessionId: id, configOptions: answer.configOptions ?? [] } as never;
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

    app.onRequest(methods.agent.session.list, async () => {
      const rows = [];
      for (const [sessionId, entry] of this.#index.list())
        rows.push(await this.#row(sessionId, entry));
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
      return { configOptions: [] } as never;
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
      if (session.status() !== "idle" && session.status() !== "stopped")
        throw sessionBusy(session.id);
      // Marked at once: the agent's own "running" comes later, and a second prompt must not slip in.
      session.agentState = "running";
      session.turnEnded = false;
      this.#changed();
      try {
        const link = await this.#ensureAgent(session);
        const answer = await link.agent.request(methods.agent.session.prompt, {
          sessionId: session.entry.agentSessionId,
          prompt: params.prompt,
        } as never);
        return answer as never;
      } catch (error) {
        // A turn that ended in failure is a turn end like any other: on record, so the session shows as unread.
        session.agentState = "idle";
        this.#changed();
        const code = (error as { code?: unknown } | null)?.code;
        this.#endTurnWithError(
          session,
          typeof code === "number" ? code : INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    });

    app.onNotification(methods.agent.session.cancel, async ({ params }) => {
      const session = this.#sessions.get(params.sessionId);
      if (session === undefined) return;
      // ACP: every pending permission request is answered "cancelled" when a turn is cancelled.
      for (const pending of [...session.pending.values()])
        this.#settle(session, pending, pending.cancelled);
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
      session?.link?.kill();
      return {} as never;
    });

    app.onRequest(methods.agent.session.delete, async ({ params }) => {
      const session = await this.#session(params.sessionId);
      if (session.status() === "running" || session.status() === "requires_action")
        throw sessionBusy(session.id);
      session.closed = true;
      session.link?.kill();
      for (const attachment of session.attachments) attachment.detach();
      await session.log.close();
      this.#sessions.delete(session.id);
      await this.#store.remove(session.id);
      await this.#index.delete(session.id);
      this.#changed();
      return {} as never;
    });

    const cycle = <P extends z.ZodType, R extends z.ZodType>(
      method: { name: `_cycle/${string}`; params: P },
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
        for (const key of Object.keys(params.config)) {
          if (!(key in known)) {
            throw new RpcError(CycleErrorCode.InvalidConfig, "The agent has no such setting", {
              agent: params.agent,
              configId: key,
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
