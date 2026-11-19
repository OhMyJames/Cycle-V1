import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { META, type QueueEntry, type QueueReason } from "@cycle/protocol";
import type { AgentLink } from "./agent-link.ts";
import type { SessionEntry } from "./index-file.ts";
import type { SessionLog } from "./log/types.ts";

/** A client connection, as far as a session needs to know it. */
export type ClientConn = {
  readonly id: string;
  /** Sends a notification to the client. */
  notify: (method: string, params: unknown) => Promise<void>;
  /** Asks the client something and waits for the answer. */
  request: (method: string, params: unknown) => Promise<unknown>;
  /** Whether the client said, in `initialize`, that it can answer a form (`elicitation/create`). */
  elicitation: boolean;
};

/** A client watching one session: what it is sent comes through the session's log. */
export type Attachment = { conn: ClientConn; detach: () => void };

/** An agent's request that is waiting for a client's answer. See docs/protocol.md §9. */
export type Pending = {
  requestId: string;
  /** What clients are asked: `session/request_permission` or `elicitation/create`. */
  method: string;
  /** What the agent is told when the request ends without an answer: a cancel, an agent that exits. */
  cancelled: unknown;
  /** The part of a client's answer that settles it. */
  answer: (response: unknown) => unknown;
  /** What clients are asked, with the daemon's session id. */
  params: Record<string, unknown>;
  settled: boolean;
  /** Clients that have been asked, so none is asked twice. */
  asked: Set<Attachment>;
  resolve: (outcome: unknown) => void;
};

/** What a client is told when the history cannot be written: the detail stays in the daemon's own error. */
export const HISTORY_NOT_SAVED = "The session's history cannot be saved, so the turn was stopped";

export type SessionStatus = "running" | "idle" | "requires_action" | "stopped";

/** What the daemon holds for a session while it is loaded. */
export class Session {
  readonly id: string;
  entry: SessionEntry;
  readonly log: SessionLog;
  link: AgentLink | undefined;
  /** The agent's last say on what it is doing. */
  agentState: "running" | "idle" | "requires_action" = "idle";
  /** The turn in progress has a turn end on record (the agent's, or the daemon's for a failure): a second is not written. */
  turnEnded = true;
  readonly pending = new Map<string, Pending>();
  /** Prompts sent while the agent was working, oldest first (docs/protocol.md §8). */
  queue: QueueEntry[] = [];
  /** Why the queue is being held for a client to attach, when it was to be handed back and none was there. */
  heldReason: QueueReason | undefined;
  /**
   * What was handed back (it is on record) while no client was attached, so nobody was there to take it: it is
   * handed back again, live, to the first client that attaches.
   */
  unclaimed: { returned: QueueEntry[]; reason: QueueReason } | undefined;
  readonly attachments = new Set<Attachment>();
  #requests = 0;
  /**
   * True while the agent is being asked to resume the session. ACP v2 has it send its current
   * state first; that is a handshake, not history, and is not logged.
   */
  resuming = false;
  /**
   * How many stops have come in while the agent was still starting. A prompt that was waiting for
   * the agent compares it before and after: a stop in between means it is not to be handed over.
   */
  startingCancels = 0;
  /**
   * The sub-agents the agent has announced and not ended, by id, and whether each runs in the
   * background. In memory only: when the agent process goes, so do they.
   */
  readonly #subagents = new Map<string, boolean>();
  /**
   * Why the session's history can no longer be written, once a write has failed. A turn that
   * cannot be saved is not run on: the session refuses new ones, and its agent is cancelled.
   */
  historyError: string | undefined;
  /** Set when the daemon lets the session go (deleted, or the daemon stops): a log closed then is not a failed one. */
  closed = false;
  /**
   * The folder's trust decision changed after this session's agent was started (or while it was
   * starting): it is stopped when it next has nothing to do, so the next start carries the new one.
   */
  trustStale = false;
  /** Set while an agent process is being started, so two prompts do not start two. */
  starting: Promise<AgentLink> | undefined;

  constructor(id: string, entry: SessionEntry, log: SessionLog) {
    this.id = id;
    this.entry = entry;
    this.log = log;
  }

  nextRequestId(): string {
    this.#requests += 1;
    return `p${this.#requests}`;
  }

  /** When something last happened in the session: its last record that is not the daemon's own. */
  updatedAt(): string {
    return this.log.updatedAt() ?? this.entry.createdAt;
  }

  unread(): boolean {
    return (this.entry.attentionSeq ?? 0) > (this.entry.readSeq ?? 0);
  }

  /** How many sub-agents run in the background. */
  backgroundCount(): number {
    let count = 0;
    for (const background of this.#subagents.values()) if (background) count += 1;
    return count;
  }

  /**
   * Takes in a `subagent_update`. A sub-agent is in the background from the first update that says
   * so until it is idle; later updates often leave the flag out, and then it stays as it was.
   * Returns whether the number in the background changed, which the list shows.
   */
  noteSubagent(update: Record<string, unknown>): boolean {
    const before = this.backgroundCount();
    const id = update.sessionId;
    if (typeof id !== "string") return false;
    const state = update.state;
    const named = typeof state === "string" ? state : (state as { state?: unknown } | null)?.state;
    const meta = (update._meta as Record<string, unknown> | null | undefined)?.[META.subagent];
    const said = (meta as { background?: unknown } | null | undefined)?.background;
    if (named === "idle") {
      this.#subagents.delete(id);
    } else if (named === "running" || this.#subagents.has(id)) {
      this.#subagents.set(
        id,
        typeof said === "boolean" ? said : (this.#subagents.get(id) ?? false),
      );
    }
    return before !== this.backgroundCount();
  }

  /** The agent process is gone, and its sub-agents with it. */
  endSubagents(): void {
    this.#subagents.clear();
  }

  status(): SessionStatus {
    if (this.pending.size > 0) return "requires_action";
    if (this.link === undefined && this.starting === undefined) return "stopped";
    return this.agentState;
  }

  /** The state as ACP's `state_update` names it: a stopped session is idle. */
  snapshot(): SessionUpdate {
    const status = this.status();
    return {
      sessionUpdate: "state_update",
      state: status === "stopped" ? "idle" : status,
      ...(this.historyError !== undefined ? { _meta: { [META.historyFailed]: true } } : {}),
    } as SessionUpdate;
  }
}
