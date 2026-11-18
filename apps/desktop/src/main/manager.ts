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
  emptyConversation,
  type HostConfig,
  type HostStatus,
  type NewSession,
  type PermissionRequest,
  type PromptBlock,
  type SessionSnapshot,
  type SessionSummary,
} from "@cycle/ui";
import { daemonUpgradeCommand, isNewer } from "../shared/release.ts";
import { LOCAL_HOST, type Settings } from "./settings.ts";

export type ManagerOptions = {
  settings: Settings;
  /** How to reach a host. The one place that knows about ssh, a local proxy, or a test socket. */
  channelFor: (host: HostConfig) => () => Promise<Channel>;
  emit: (event: AppEvent) => void;
  chooseDirectory?: () => Promise<string | undefined>;
  backoff?: { first: number; max: number };
  /** The version of this app, to tell a host whose daemon is older. Without it, nothing is said. */
  appVersion?: string;
  /** A session changed in a way worth telling (it asks, it is done, its agent is gone). Without it, nothing is said. */
  attention?: (notice: AttentionNotice) => void;
};

/** What the main process is told when a session that was changing is in a state that wants the person. */
export type AttentionNotice = {
  hostId: string;
  hostName: string;
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
  status: HostStatus;
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
  #hosts: HostConfig[] = [LOCAL_HOST];
  readonly #connections = new Map<string, Connection>();
  /** The last list read from each host, kept when its connection goes: what the interface greys out. */
  readonly #lastSessions = new Map<string, SessionSummary[]>();
  /** Why the last attempt to connect to a host failed, for a renderer that asks after the event went by. */
  readonly #lastError = new Map<string, string>();

  constructor(options: ManagerOptions) {
    this.#options = options;
  }

  async init(): Promise<void> {
    this.#hosts = await this.#options.settings.load();
  }

  async close(): Promise<void> {
    for (const connection of this.#connections.values()) await connection.client.close();
    this.#connections.clear();
  }

  // ---- hosts ----

  async hosts() {
    return {
      hosts: this.#hosts,
      status: this.#hosts.map((host): HostStatus => {
        const error = this.#lastError.get(host.id);
        return (
          this.#connections.get(host.id)?.status ?? {
            hostId: host.id,
            state: "closed",
            ...(error !== undefined ? { error } : {}),
          }
        );
      }),
      sessions: Object.fromEntries(this.#lastSessions),
    };
  }

  /**
   * Connects to every host, each on its own: one that cannot be reached is closed, with why, and the others
   * are not held up by it. What is wrong with a host is in its status; nothing is thrown.
   */
  async connectAll(): Promise<void> {
    await Promise.allSettled(this.#hosts.map((host) => this.connect(host.id)));
  }

  async saveHost(host: HostConfig): Promise<void> {
    if (host.id === LOCAL_HOST.id) throw new Error("The local daemon cannot be changed");
    const rest = this.#hosts.filter((h) => h.id !== host.id);
    this.#hosts = [...rest, host];
    await this.#options.settings.save(this.#hosts);
    this.#options.emit({ type: "hosts", hosts: this.#hosts });
  }

  async removeHost(hostId: string): Promise<void> {
    if (hostId === LOCAL_HOST.id) throw new Error("The local daemon cannot be removed");
    await this.disconnect(hostId);
    this.#lastSessions.delete(hostId);
    this.#lastError.delete(hostId);
    this.#hosts = this.#hosts.filter((h) => h.id !== hostId);
    await this.#options.settings.save(this.#hosts);
    this.#options.emit({ type: "hosts", hosts: this.#hosts });
  }

  async connect(hostId: string): Promise<void> {
    const existing = this.#connections.get(hostId);
    if (existing && existing.status.state !== "closed") return;
    const host = this.#hosts.find((h) => h.id === hostId);
    if (host === undefined) throw new Error(`No such host: ${hostId}`);

    const connection: Connection = {
      client: undefined as unknown as CycleClient,
      status: { hostId, state: "connecting" },
      sessions: [],
      watched: new Map(),
      opening: new Map(),
      asked: 0,
      applied: 0,
    };
    connection.client = new CycleClient({
      connect: this.#options.channelFor(host),
      name: "cycle-desktop",
      ...(this.#options.backoff !== undefined ? { backoff: this.#options.backoff } : {}),
      events: {
        update: (sessionId, update) => this.#onUpdate(hostId, connection, sessionId, update),
        permission: (sessionId, request, requestId) =>
          this.#onPermission(hostId, connection, sessionId, request, requestId),
        resolved: (sessionId, requestId) =>
          this.#onResolved(hostId, connection, sessionId, String(requestId)),
        listChanged: () => void this.#refreshSessions(hostId, connection).catch(() => undefined),
        defaultsChanged: (agent) => this.#options.emit({ type: "agent-defaults", hostId, agent }),
        connection: (state, error) => {
          // A connection that came back asks for the list again: it may have changed while away.
          const was = connection.status.state;
          if (state === was && error === undefined) return;
          connection.status = {
            hostId,
            state,
            ...(error !== undefined ? { error: messageOf(error) } : {}),
            ...(state === "connected" ? this.#daemonOf(host, connection.client) : {}),
          };
          this.#options.emit({ type: "host-status", ...connection.status });
          if (state === "connected" && was === "reconnecting") {
            void this.#refreshSessions(hostId, connection, true).catch(() => undefined);
          }
        },
      },
    });
    this.#connections.set(hostId, connection);
    this.#options.emit({ type: "host-status", ...connection.status });
    try {
      await connection.client.start();
    } catch (error) {
      this.#connections.delete(hostId);
      this.#lastError.set(hostId, messageOf(error));
      this.#options.emit({ type: "host-status", hostId, state: "closed", error: messageOf(error) });
      throw error;
    }
    this.#lastError.delete(hostId);
    await this.#refreshSessions(hostId, connection);
  }

  /** What a connected remote host's daemon is, and whether it is behind this app. */
  #daemonOf(host: HostConfig, client: CycleClient): Pick<HostStatus, "daemon"> {
    const version = client.serverVersion;
    if (host.kind === "local" || version === undefined) return {};
    const { appVersion } = this.#options;
    const behind = appVersion !== undefined && isNewer(appVersion, version);
    return {
      daemon: { version, ...(behind ? { upgrade: daemonUpgradeCommand(appVersion) } : {}) },
    };
  }

  async disconnect(hostId: string): Promise<void> {
    const connection = this.#connections.get(hostId);
    if (connection === undefined) return;
    this.#connections.delete(hostId);
    for (const watched of connection.watched.values()) {
      for (const pending of watched.pending.values()) pending.answer({ outcome: "cancelled" });
    }
    await connection.client.close();
    this.#options.emit({ type: "host-status", hostId, state: "closed" });
  }

  #connection(hostId: string): Connection {
    const connection = this.#connections.get(hostId);
    if (connection === undefined) throw new Error("Not connected to that host");
    return connection;
  }

  // ---- sessions ----

  async sessions(hostId: string): Promise<SessionSummary[]> {
    return this.#refreshSessions(hostId, this.#connection(hostId));
  }

  /**
   * Reads the session list and tells the renderer. `afterOutage`: the connection was away, so a session that went from
   * working to stopped may only have been released while nobody watched, and what finished is old news: only a session
   * that is asking (and is still asking) is told.
   */
  async #refreshSessions(
    hostId: string,
    connection: Connection,
    afterOutage = false,
  ): Promise<SessionSummary[]> {
    const asked = ++connection.asked;
    const rows = await connection.client.listSessions();
    const sessions = rows.map((row): SessionSummary => {
      const meta = (row._meta ?? {}) as Record<string, unknown>;
      return {
        hostId,
        sessionId: row.sessionId,
        cwd: row.cwd,
        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
        archived: meta["cycle/archived"] === true,
        agent: String(meta["cycle/agent"] ?? ""),
        state: (meta["cycle/state"] as SessionSummary["state"]) ?? "stopped",
        lastSeq: Number(meta["cycle/lastSeq"] ?? 0),
        ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
        ...(typeof meta["cycle/config"] === "object" && meta["cycle/config"] !== null
          ? { config: meta["cycle/config"] as Record<string, string> }
          : {}),
      };
    });
    // An answer to an older question, arriving after the answer to a newer one, would put the list back.
    if (asked < connection.applied) return connection.sessions;
    connection.applied = asked;
    const before = new Map(connection.sessions.map((s) => [s.sessionId, s]));
    connection.sessions = sessions;
    this.#lastSessions.set(hostId, sessions);
    this.#options.emit({ type: "sessions", hostId, sessions });
    this.#tell(hostId, before, sessions, afterOutage);
    return sessions;
  }

  /** What changed since the list before is what the person may want to be told. A hook that fails must not break the list. */
  #tell(
    hostId: string,
    before: ReadonlyMap<string, SessionSummary>,
    sessions: readonly SessionSummary[],
    afterOutage: boolean,
  ): void {
    const attention = this.#options.attention;
    if (attention === undefined) return;
    const hostName = this.#hosts.find((h) => h.id === hostId)?.name ?? hostId;
    for (const session of sessions) {
      const kind = attentionOf(before.get(session.sessionId), session);
      if (kind === undefined || (afterOutage && kind !== "needs-you")) continue;
      try {
        attention({ hostId, hostName, session, kind });
      } catch {
        // A notification that cannot be shown is a notification missed, not a list that cannot be read.
      }
    }
  }

  async createSession(hostId: string, params: NewSession): Promise<string> {
    const connection = this.#connection(hostId);
    const sessionId = await connection.client.newSession(params);
    await this.#refreshSessions(hostId, connection);
    return sessionId;
  }

  async openSession(hostId: string, sessionId: string): Promise<SessionSnapshot> {
    const connection = this.#connection(hostId);
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

  #onUpdate(
    hostId: string,
    connection: Connection,
    sessionId: string,
    update: Parameters<typeof applyUpdate>[1],
  ) {
    const watched = connection.watched.get(sessionId);
    if (watched === undefined) return;
    watched.conversation = applyUpdate(watched.conversation, update);
    watched.version += 1;
    this.#options.emit({ type: "update", hostId, sessionId, update, version: watched.version });
  }

  async prompt(hostId: string, sessionId: string, content: string | PromptBlock[]): Promise<void> {
    const blocks =
      typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
    await this.#connection(hostId).client.prompt(sessionId, blocks);
  }

  async cancel(hostId: string, sessionId: string): Promise<void> {
    await this.#connection(hostId).client.cancel(sessionId);
  }

  async setSessionConfig(hostId: string, sessionId: string, configId: string, value: string) {
    await this.#connection(hostId).client.setConfig(sessionId, configId, value);
  }

  async renameSession(hostId: string, sessionId: string, title: string): Promise<void> {
    await this.#connection(hostId).client.rename(sessionId, title);
  }

  async archiveSession(hostId: string, sessionId: string, archived: boolean): Promise<void> {
    await this.#connection(hostId).client.archive(sessionId, archived);
  }

  async deleteSession(hostId: string, sessionId: string): Promise<void> {
    const connection = this.#connection(hostId);
    await connection.client.delete(sessionId);
    connection.watched.delete(sessionId);
  }

  // ---- permissions ----

  #onPermission(
    hostId: string,
    connection: Connection,
    sessionId: string,
    request: Record<string, unknown>,
    requestId: string | undefined,
  ): Promise<PermissionAnswer> {
    const key = `${hostId}:${sessionId}:${requestId ?? randomUUID()}`;
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
        hostId,
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
    for (const [hostId, connection] of this.#connections) {
      for (const [sessionId, watched] of connection.watched) {
        const pending = watched.pending.get(key);
        if (pending === undefined) continue;
        pending.answer(
          optionId === "cancelled" ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        );
        this.#closePermission(hostId, sessionId, watched, key);
        return;
      }
    }
  }

  #closePermission(hostId: string, sessionId: string, watched: Watched, key: string): void {
    watched.pending.delete(key);
    watched.version += 1;
    this.#options.emit({
      type: "permission-closed",
      hostId,
      sessionId,
      key,
      version: watched.version,
    });
  }

  #onResolved(hostId: string, connection: Connection, sessionId: string, requestId: string): void {
    const watched = connection.watched.get(sessionId);
    const key = `${hostId}:${sessionId}:${requestId}`;
    const pending = watched?.pending.get(key);
    if (watched === undefined || pending === undefined) return;
    // Answered somewhere else. Free this client's request, and close the dialog.
    pending.answer({ outcome: "cancelled" });
    this.#closePermission(hostId, sessionId, watched, key);
  }

  // ---- agents ----

  async agents(hostId: string): Promise<AgentInfo[]> {
    return (await this.#connection(hostId).client.agents()).agents;
  }

  async agentDefaults(hostId: string, agent: string): Promise<Record<string, string>> {
    return this.#connection(hostId).client.agentDefaults(agent);
  }

  async setAgentDefaults(
    hostId: string,
    agent: string,
    config: Record<string, string>,
  ): Promise<void> {
    await this.#connection(hostId).client.setAgentDefaults(agent, config);
  }

  chooseDirectory(): Promise<string | undefined> {
    return this.#options.chooseDirectory?.() ?? Promise.resolve(undefined);
  }
}
