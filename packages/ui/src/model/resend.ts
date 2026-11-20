// Sending again what a failed turn was asked (DESIGN.md 4.4): what goes back in the box, and what the person is told
// before. Pure: the conversation alone says it, live or replayed.
import type { Block, Conversation, ToolItem } from "./conversation.ts";

/**
 * Tool kinds (ACP's `kind`) that change things: a command, a file written, removed or moved. A call of one of these that
 * started may have done its work before the turn failed, and sending the message again may do it again.
 */
const CHANGES = new Set(["execute", "edit", "delete", "move"]);

/** What kind of failure ended the turn, by its code: words for the person and for counting, never the message. */
export type Failure = "agent_exited" | "daemon_stopped" | "history" | "resume" | "agent_error";

/** Cycle's error codes (docs/protocol.md §11). Anything else is the agent's own: an API error, a limit, a sign-in. */
export const failureOf = (code: number | undefined): Failure => {
  switch (code) {
    case -32012:
      return "agent_exited";
    case -32018:
      return "daemon_stopped";
    case -32015:
      return "history";
    case -32013:
      return "resume";
    default:
      return "agent_error";
  }
};

export type Resend = {
  /** The turn that failed. */
  turn: number;
  /** What the person said in it, in order: the message, and any put into it while it ran. */
  prompts: Block[][];
  /** Calls in it that may have changed something before it failed. */
  changed: ToolItem[];
  failure: Failure;
};

/**
 * What can be sent again: the last turn, when it failed (not a stop, not a limit) and nothing has happened since, and
 * the person said something in it (a turn the agent began by itself has nothing to send). Otherwise nothing.
 */
export const resendOf = (c: Conversation): Resend | undefined => {
  if (c.status !== "idle" || c.turns === 0 || c.replaying) return undefined;
  const turn = c.turns - 1;
  const stop = c.stops[turn];
  if (stop?.stopReason !== "error") return undefined;
  if (c.items.some((item) => item.turn > turn)) return undefined;
  const prompts: Block[][] = [];
  const changed: ToolItem[] = [];
  for (const item of c.items) {
    if (item.turn !== turn) continue;
    if (item.kind === "user" && item.blocks.length > 0) prompts.push(item.blocks);
    // A call that only waited (for a permission, say) did nothing. One that began and was cut short may have.
    if (item.kind === "tool" && CHANGES.has(item.toolKind ?? "") && item.started === true)
      changed.push(item);
  }
  if (prompts.length === 0) return undefined;
  return { turn, prompts, changed, failure: failureOf(stop.error?.code ?? undefined) };
};
