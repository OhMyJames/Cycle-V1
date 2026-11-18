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
  /** On a permission request sent to a client: the daemon's id for it, as `_cycle/request_resolved` names it. */
  requestId: "cycle/requestId",
} as const;

/** The version of Cycle's protocol, "major.minor". A different major is refused. */
export const CYCLE_PROTOCOL_VERSION = "0.1";

export const ProtocolVersionSchema = z.string().regex(/^\d+\.\d+$/);

/** `replayFrom` kinds the daemon understands: ACP's `start`, and Cycle's own `_cycle.seq`. */
export const REPLAY_KINDS = ["start", "_cycle.seq"] as const;

export const CapabilitiesSchema = z.object({
  replay: z.array(z.string()),
  agents: z.array(z.string()),
  sessionOps: z.array(z.string()),
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

/** The sequence number on an update's `_meta`, or undefined if it carries none. */
export const seqOf = (meta: unknown): number | undefined => {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[META.seq];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
};
