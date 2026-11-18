// How the sessions are ordered and grouped for the list, and which of them are shown: pure, so the list on screen and the
// keyboard walking it (Cmd+[ and Cmd+]) are one thing and are tested without a page.
//
// What waits on the person comes first, then what is working, then the rest by project. A session list row has no
// pin and no time, only a sequence number, so there are no "Pinned" or "Today" groups: they have nothing to come from.
import type { SessionSummary } from "./api.ts";

/** How many of a project's sessions show before "Show more". */
export const PER_PROJECT = 20;

export type SessionGroup = {
  /** Unique among the groups, and the same from one call to the next. */
  key: string;
  kind: "needs-you" | "working" | "project";
  /** A project's name (see `names` of the list); empty for the first two groups, and for a session with no folder. */
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
  /** The name of each project, by its folder as `projectOf` gives it. */
  names: ReadonlyMap<string, string>;
};

export type SessionListOptions = {
  showArchived: boolean;
  /** Lifts the limit of each project. */
  showAll: boolean;
  /** The open session: its project shows it, however far down it is. */
  selected?: string | undefined;
};

/** The folder a session belongs to as a project: without a trailing slash (`/a/app` and `/a/app/` are one). */
export const projectOf = (session: SessionSummary): string => {
  const trimmed = session.cwd.replace(/\/+$/, "");
  return trimmed === "" ? (session.cwd.startsWith("/") ? "/" : "") : trimmed;
};

const before = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const newest = (a: SessionSummary, b: SessionSummary): number =>
  b.lastSeq - a.lastSeq || before(a.sessionId, b.sessionId);

const parts = (folder: string): string[] => folder.split("/").filter(Boolean);

/** The names of the projects: the last part of the folder, with more of it only where two would be the same. */
const namesOf = (folders: readonly string[]): Map<string, string> => {
  const segments = new Map(folders.map((folder) => [folder, parts(folder)]));
  const depth = new Map(folders.map((folder) => [folder, 1]));
  const label = (folder: string): string => {
    const all = segments.get(folder) ?? [];
    const take = depth.get(folder) ?? 1;
    // At most the whole path, which no other folder has.
    return all.length === 0 ? folder : all.slice(-take).join("/");
  };
  for (let round = 0; round < 64; round += 1) {
    const byLabel = new Map<string, string[]>();
    for (const folder of folders)
      byLabel.set(label(folder), [...(byLabel.get(label(folder)) ?? []), folder]);
    let grew = false;
    for (const same of byLabel.values()) {
      if (same.length < 2) continue;
      for (const folder of same) {
        if ((depth.get(folder) ?? 1) < (segments.get(folder)?.length ?? 0)) {
          depth.set(folder, (depth.get(folder) ?? 1) + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Map(folders.map((folder) => [folder, label(folder)]));
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
    const folder = projectOf(session);
    const list = byProject.get(folder);
    if (list === undefined) byProject.set(folder, [session]);
    else list.push(session);
  }
  const names = namesOf([...new Set(shown.map(projectOf))]);
  const projects = [...byProject].toSorted(
    ([a, left], [b, right]) => (right[0]?.lastSeq ?? 0) - (left[0]?.lastSeq ?? 0) || before(a, b),
  );
  // The open session's project shows it, however far down it is, and by where the session stands among that folder's
  // sessions whatever its state: so the list does not grow and shrink as the session moves between Working and its project.
  const open = shown.find((s) => s.sessionId === selected);
  const openFolder = open === undefined ? undefined : projectOf(open);
  const openAt =
    open === undefined ? 0 : shown.filter((s) => projectOf(s) === openFolder).indexOf(open) + 1;
  const groups: SessionGroup[] = [];
  if (needs.length > 0)
    groups.push({ key: "needs-you", kind: "needs-you", label: "", sessions: needs, hidden: 0 });
  if (working.length > 0)
    groups.push({ key: "working", kind: "working", label: "", sessions: working, hidden: 0 });
  let hidden = 0;
  for (const [folder, all] of projects) {
    const limit = showAll ? all.length : Math.max(PER_PROJECT, folder === openFolder ? openAt : 0);
    const list = all.slice(0, limit);
    hidden += all.length - list.length;
    groups.push({
      key: `project:$folder`,
      kind: "project",
      label: names.get(folder) ?? folder,
      sessions: list,
      hidden: all.length - list.length,
    });
  }
  return { groups, order: groups.flatMap((g) => g.sessions), hidden, names };
};
