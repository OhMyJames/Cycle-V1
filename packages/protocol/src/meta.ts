import { z } from "zod";

/** Keys Cycle puts in ACP's `_meta`. See docs/protocol.md. */
export const META = {
  /** The daemon's per-session sequence number of a record, on every forwarded `session/update`. */
  seq: "cycle/seq",
  /** In `initialize`: Cycle's own protocol version, "major.minor". */
  protocolVersion: "cycle/protocolVersion",
  /** In the `initialize` response: what this daemon can do. */
  capabilities: "cycle/capabilities",
  /** In `session/new`: the agent to run. */
  agent: "cycle/agent",
  /** In `session/new`: the initial configuration, checked against the agent's `configSchema`. */
  config: "cycle/config",
  /** In `session/new`: the id the daemon proposes for the agent's own session. */
  sessionId: "cycle/sessionId",
  /** In a `session/list` row. */
  archived: "cycle/archived",
  state: "cycle/state",
  lastSeq: "cycle/lastSeq",
  /** In a `session/list` row: whether something worth seeing came after the last `_cycle/session/mark_read`. */
  unread: "cycle/unread",
  /** In a `session/list` row: how many background sub-agents are still running. Absent when none. */
  background: "cycle/background",
  /** In a session/list row, and in the state_update a client opens a session with: true once the session's history could not be written (docs/protocol.md section 12). Absent otherwise. */
  historyFailed: "cycle/historyFailed",
  /** In a `subagent_update`: what the adapter says of the task beyond ACP's fields (decision 0014). */
  subagent: "cycle/subagent",
  /** In a `session/list` row: the context the session uses and what it has cost (`SessionUsageSchema`). */
  usage: "cycle/usage",
  /** On a permission request sent to a client: the daemon's id for it, as `_cycle/request_resolved` names it. */
  requestId: "cycle/requestId",
  /** On the answer to an `elicitation/create` nobody could be asked: no attached client has the capability. */
  noClient: "cycle/noClient",
  /** On the answer to a `session/prompt` that was queued, not sent: the agent was still working. */
  queued: "cycle/queued",
} as const;

/** The version of Cycle's protocol, "major.minor". A different major is refused. */
export const CYCLE_PROTOCOL_VERSION = "0.2";

export const ProtocolVersionSchema = z.string().regex(/^\d+\.\d+$/);

/** `replayFrom` kinds the daemon understands: ACP's `start`, and Cycle's own `_cycle.seq`. */
export const REPLAY_KINDS = ["start", "_cycle.seq"] as const;

export const CapabilitiesSchema = z.object({
  replay: z.array(z.string()),
  agents: z.array(z.string()),
  sessionOps: z.array(z.string()),
  /** Prompts sent while the agent works are queued by the daemon (docs/protocol.md §8). */
  queue: z.boolean().optional(),
  /** `_cycle/files/search` is there (docs/protocol.md §8). */
  files: z.boolean().optional(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** Replay everything after a sequence number. An extension of ACP's `ReplayFrom`. */
export const ReplayFromSeqSchema = z.object({
  type: z.literal("_cycle.seq"),
  after: z.number().int().nonnegative(),
});
export type ReplayFromSeq = z.infer<typeof ReplayFromSeqSchema>;

/** What a session is doing, as the session list shows it. `stopped`: no agent process. */
export const SessionStateSchema = z.enum(["running", "idle", "requires_action", "stopped"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * What the latest `usage_update` said: tokens in context, the window they are in, and the cost so
 * far. The daemon keeps it in the index, so a list shows it without replaying a log.
 */
export const SessionUsageSchema = z.object({
  used: z.number().nonnegative(),
  size: z.number().positive(),
  cost: z.object({ amount: z.number().nonnegative(), currency: z.string() }).nullish(),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

/** The sequence number on an update's `_meta`, or undefined if it carries none. */
export const seqOf = (meta: unknown): number | undefined => {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[META.seq];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
};
