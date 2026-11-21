// What the context window holds, by kind, as Claude Code's `/context` counts it: carried on the `usage_update` that
// ends a turn (docs/protocol.md §8). Asked of the process with `getContextUsage({ detail: "summary" })`, which answers
// from the last response's usage and local estimates, without calling the API.
import type { Query } from "@anthropic-ai/claude-agent-sdk";

/** `_meta` key on a `usage_update`: what the window holds. Same as `META.context`. */
export const CONTEXT_META = "cycle/context";

/** How long the end of a turn waits for the breakdown before it tells the usage without one. */
export const CONTEXT_WAIT_MS = 2000;

const KINDS = ["used", "free", "buffer", "deferred"] as const;

export type ContextPart = {
  /** Which part this is (`system_prompt`, `messages`, …): stable where `name` is not. Absent from an older CLI. */
  id?: string;
  /** The CLI's own English name for it, for a part a client does not know by its id. */
  name: string;
  tokens: number;
  /** `used` is in the window; `free` is what is left; `buffer` is kept for compaction; `deferred` is not loaded. */
  kind: (typeof KINDS)[number];
};

export type ContextBreakdown = {
  /** The window Claude Code measures against: the model's, or its compaction window when that is smaller. */
  window: number;
  /** Each part with tokens in it, in the CLI's order. */
  parts: ContextPart[];
  /** Where automatic compaction starts, in tokens; absent when it is off. */
  autoCompactAt?: number;
};

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** The breakdown in an answer of `getContextUsage`, or `undefined` when it is not one. */
export const contextBreakdownOf = (answer: unknown): ContextBreakdown | undefined => {
  if (typeof answer !== "object" || answer === null) return undefined;
  const a = answer as Record<string, unknown>;
  const window = count(a.rawMaxTokens);
  if (window === undefined || window === 0 || !Array.isArray(a.categories)) return undefined;
  const parts = a.categories.flatMap((c): ContextPart[] => {
    if (typeof c !== "object" || c === null) return [];
    const { id, name, tokens, kind } = c as Record<string, unknown>;
    const n = count(tokens);
    if (typeof name !== "string" || n === undefined || n === 0) return [];
    if (!KINDS.includes(kind as ContextPart["kind"])) return [];
    return [
      {
        ...(typeof id === "string" ? { id } : {}),
        name,
        tokens: n,
        kind: kind as ContextPart["kind"],
      },
    ];
  });
  const threshold = count(a.autoCompactThreshold);
  return {
    window,
    parts,
    ...(a.isAutoCompactEnabled === true && threshold !== undefined
      ? { autoCompactAt: threshold }
      : {}),
  };
};

/** Asks the process what its window holds; `undefined` when it cannot say, or not in time. */
export const askContext = async (
  query: Query | undefined,
  waitMs = CONTEXT_WAIT_MS,
): Promise<ContextBreakdown | undefined> => {
  if (query === undefined || typeof query.getContextUsage !== "function") return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      query.getContextUsage({ detail: "summary" }).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, waitMs, undefined);
      }),
    ]);
    return contextBreakdownOf(answer);
  } finally {
    clearTimeout(timer);
  }
};
