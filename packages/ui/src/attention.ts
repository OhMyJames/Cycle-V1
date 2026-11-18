// What is worth telling the person when a session they may not be looking at changes. Pure: the main process uses it to
// decide when to show a notification, and it is tested without one.
//
// Only a change is worth telling: the first time a list is read says nothing, and neither does a session that goes on
// being what it was.
import type { SessionSummary } from "./api.ts";

export type Attention =
  /** It asks the person something (a permission, a question) and waits. */
  | "needs-you"
  /** It was working, and is done. */
  | "finished"
  /** It was working, and its agent is gone: not the quiet release of an idle one. */
  | "stopped";

const going = (state: SessionSummary["state"] | undefined): boolean =>
  state === "running" || state === "requires_action";

/** What to tell the person about a session that has gone from `before` to `after`, or nothing. */
export const attentionOf = (
  before: SessionSummary | undefined,
  after: SessionSummary,
): Attention | undefined => {
  // New to the list (or the first list): nothing changed that anyone saw. An archived session is put away.
  if (before === undefined || after.archived) return undefined;
  if (after.state === "requires_action")
    return before.state === "requires_action" ? undefined : "needs-you";
  if (!going(before.state)) return undefined;
  if (after.state === "idle") return "finished";
  if (after.state === "stopped") return "stopped";
  return undefined;
};
