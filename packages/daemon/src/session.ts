import type { SessionUpdate } from "@cycle/acp";
import type { QueueEntry, QueueReason } from "@cycle/protocol";
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

export type SessionStatus = "running" | "idle" | "requires_action" | "stopped";

/** What the daemon holds for a session while it is loaded. */
export class Session {
  readonly id: string;
  entry: SessionEntry;
  readonly log: SessionLog;
  link: AgentLink | undefined;
  /** The agent's last say on what it is doing. */
  agentState: "running" | "idle" | "requires_action" = "idle";
  readonly pending = new Map<string, Pending>();
  /** Prompts sent while the agent was working, oldest first (docs/protocol.md §8). */
  queue: QueueEntry[] = [];
  /** Why the queue is being held for a client to attach, when it was to be handed back and none was there. */
  heldReason: QueueReason | undefined;
  readonly attachments = new Set<Attachment>();
  #requests = 0;
  /**
   * True while the agent is being asked to resume the session. ACP v2 has it send its current
   * state first; that is a handshake, not history, and is not logged.
   */
  resuming = false;
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
    } as SessionUpdate;
  }
}
