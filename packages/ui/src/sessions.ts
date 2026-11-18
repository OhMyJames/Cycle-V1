// How the sessions are ordered and grouped for the list, and which of them are shown: pure, so the list on screen and the
// keyboard walking it (Cmd+[ and Cmd+]) are one thing and are tested without a page.
//
// What waits on the person comes first, then what is working, then the rest by project. A session list row has no
// pin and no time, only a sequence number, so there are no "Pinned" or "Today" groups: they have nothing to come from.
import type { SessionSummary } from "./api.ts";

/** How many of a project's sessions show before "Show all". */
export const PER_PROJECT = 20;

export type SessionGroup = {
  /** Unique among the groups, and the same from one call to the next. */
  key: string;
  kind: "needs-you" | "working" | "project";
  /** A project's name: the last part of its folder, or the last two when another project ends the same way. */
  label: string;
  /** What is shown. */
  sessions: SessionSummary[];
  /** How many more the project has than are shown. */
  hidden: number;
};

export type SessionList = {
  groups: SessionGroup[];
  /** The sessions shown, in the order they are on screen. */
  order: SessionSummary[];
  /** How many sessions are not shown because of the limit. */
  hidden: number;
};

export type SessionListOptions = {
  showArchived: boolean;
  /** Lifts the limit of each project. */
  showAll: boolean;
  /** The open session: its project shows it, however far down it is. */
  selected?: string | undefined;
};

const newest = (a: SessionSummary, b: SessionSummary): number =>
  b.lastSeq - a.lastSeq || a.sessionId.localeCompare(b.sessionId);

const parts = (cwd: string): string[] => cwd.split("/").filter(Boolean);

/** The names of the projects: the last part of the folder, longer only where two would be the same. */
const labels = (cwds: readonly string[]): Map<string, string> => {
  const byLast = new Map<string, string[]>();
  for (const cwd of cwds) {
    const last = parts(cwd).at(-1) ?? cwd;
    byLast.set(last, [...(byLast.get(last) ?? []), cwd]);
  }
  const result = new Map<string, string>();
  for (const cwd of cwds) {
    const segments = parts(cwd);
    const last = segments.at(-1) ?? cwd;
    const clash = (byLast.get(last)?.length ?? 0) > 1;
    result.set(cwd, clash ? segments.slice(-2).join("/") : last);
  }
  return result;
};

export const sessionList = (
  sessions: readonly SessionSummary[],
  { showArchived, showAll, selected }: SessionListOptions,
): SessionList => {
  const shown = sessions.filter((s) => showArchived || !s.archived).toSorted(newest);
  // An archived session is put away: it waits for no one, and is not "working" even if its state says so.
  const needs = shown.filter((s) => !s.archived && s.state === "requires_action");
  const working = shown.filter((s) => !s.archived && s.state === "running");
  const apart = new Set([...needs, ...working]);
  const byProject = new Map<string, SessionSummary[]>();
  for (const session of shown) {
    if (apart.has(session)) continue;
    const list = byProject.get(session.cwd);
    if (list === undefined) byProject.set(session.cwd, [session]);
    else list.push(session);
  }
  const names = labels([...byProject.keys()]);
  const projects = [...byProject].toSorted(
    ([a, left], [b, right]) =>
      (right[0]?.lastSeq ?? 0) - (left[0]?.lastSeq ?? 0) || a.localeCompare(b),
  );
  const groups: SessionGroup[] = [];
  if (needs.length > 0)
    groups.push({ key: "needs-you", kind: "needs-you", label: "", sessions: needs, hidden: 0 });
  if (working.length > 0)
    groups.push({ key: "working", kind: "working", label: "", sessions: working, hidden: 0 });
  let hidden = 0;
  for (const [cwd, all] of projects) {
    const open = showAll || all.some((s) => s.sessionId === selected);
    const list = open ? all : all.slice(0, PER_PROJECT);
    hidden += all.length - list.length;
    groups.push({
      key: `project:${cwd}`,
      kind: "project",
      label: names.get(cwd) ?? cwd,
      sessions: list,
      hidden: all.length - list.length,
    });
  }
  return { groups, order: groups.flatMap((g) => g.sessions), hidden };
};
