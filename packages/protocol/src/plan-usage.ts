// How much of a subscription's usage limits is used, and when each window starts over (docs/protocol.md §8 "套餐用量").
// It belongs to the account an agent signs in with on the daemon's machine, not to a session: an agent tells it in
// a session's stream, the daemon keeps the latest for that agent and tells every client, and nothing of it is written
// to a session's history.
import { z } from "zod";
import { cycleMethod } from "./method.ts";

/** The `session/update` variant an agent tells it in. The daemon takes it; no client sees it as a session's update. */
export const PLAN_USAGE_UPDATE = "_cycle/plan_usage";

export const PlanWindowSchema = z.object({
  /** Which limit: `five_hour`, `seven_day`, or another the agent names (`seven_day_opus`, …). */
  kind: z.string().min(1).max(64),
  /** The share of it used, from 0; past 1 when over. */
  utilization: z.number().min(0).max(100),
  /** When it starts over, in milliseconds since the epoch. */
  resetsAt: z.number().int().nonnegative(),
  /** What the agent's service says of it: fine, close to the limit, or at it. */
  status: z.enum(["allowed", "allowed_warning", "rejected"]).optional(),
});
export type PlanWindow = z.infer<typeof PlanWindowSchema>;

export const PlanUsageSchema = z.object({
  windows: z.array(PlanWindowSchema).max(16),
  /** When the agent told it, in milliseconds since the epoch: it is as of then. */
  at: z.number().int().nonnegative(),
});
export type PlanUsage = z.infer<typeof PlanUsageSchema>;

/** The latest plan usage of each agent that told one since the daemon started. */
export const planUsageRead = cycleMethod(
  "_cycle/plan_usage/read",
  z.object({}),
  z.object({ agents: z.record(z.string(), PlanUsageSchema) }),
);

/** Sent to every client when an agent's plan usage changes. */
export const PLAN_USAGE_CHANGED = "_cycle/plan_usage_changed";
export const PlanUsageChangedSchema = z.object({ agent: z.string(), usage: PlanUsageSchema });
