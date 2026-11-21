// A subscription's usage limits, as Claude Code learns them from each API response and tells them in a
// `rate_limit_event`: told on as Cycle's `_cycle/plan_usage` (docs/protocol.md §8 "套餐用量"). A login with an API key
// has no such limits, and Claude Code then says nothing.

/** The `session/update` variant the daemon takes plan usage in. Same as `PLAN_USAGE_UPDATE` of `@cycle/protocol`. */
export const PLAN_USAGE_UPDATE = "_cycle/plan_usage";

export type PlanWindow = {
  kind: string;
  /** The share used, from 0. */
  utilization: number;
  /** In milliseconds since the epoch. */
  resetsAt: number;
  status?: PlanStatus;
};

type PlanStatus = "allowed" | "allowed_warning" | "rejected";
const STATUSES: readonly string[] = ["allowed", "allowed_warning", "rejected"];

const windowOf = (kind: string, value: unknown): PlanWindow[] => {
  if (typeof value !== "object" || value === null) return [];
  const { utilization, resetsAt, status } = value as Record<string, unknown>;
  if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0)
    return [];
  // Claude Code gives seconds.
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return [];
  return [
    {
      kind: kind.slice(0, 64),
      utilization: Math.min(utilization, 100),
      resetsAt: Math.round(resetsAt * 1000),
      ...(typeof status === "string" && STATUSES.includes(status)
        ? { status: status as PlanStatus }
        : {}),
    },
  ];
};

/**
 * The windows in a `rate_limit_event`'s `rate_limit_info`: every one it lists (`unifiedWindows`, which Claude Code
 * sends with each response and the SDK's types do not name yet), or else the one it is about.
 */
export const planWindowsOf = (info: unknown): PlanWindow[] => {
  if (typeof info !== "object" || info === null) return [];
  const i = info as Record<string, unknown>;
  const all = i.unifiedWindows;
  if (typeof all === "object" && all !== null && !Array.isArray(all)) {
    const windows = Object.entries(all).flatMap(([kind, w]) => windowOf(kind, w));
    if (windows.length > 0) return windows.slice(0, 16);
  }
  return typeof i.rateLimitType === "string" ? windowOf(i.rateLimitType, i) : [];
};
