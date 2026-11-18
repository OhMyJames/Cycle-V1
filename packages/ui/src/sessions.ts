// How the sessions are ordered and grouped for the list, and which of them are shown: pure, so the list on screen and the
// keyboard walking it (Cmd+[ and Cmd+]) are one thing and are tested without a page.
//
// What waits on the person comes first, then what is working, then the rest by project. A session list row has no
// pin and no time, only a sequence number, so there are no "Pinned" or "Today" groups: they have nothing to come from.
import type { SessionSummary } from "./api.ts";
import { viewKey } from "./store/store.ts";

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
  /** The name of each project, by its `projectKey`. */
  names: ReadonlyMap<string, string>;
};

/** What the list needs to know of a host to name its projects. */
export type HostLabel = { id: string; name: string; local: boolean };

export type SessionListOptions = {
  showArchived: boolean;
  /** Lifts the limit of each project. */
  showAll: boolean;
  /** The open session, by its `sessionKey`: its project shows it, however far down it is. */
  selected?: string | undefined;
  /**
   * The hosts, so that a project on another machine is named as such ("app · build-box"): the same folder on two
   * hosts is two projects. Without it no project is named after its host.
   */
  hosts?: readonly HostLabel[] | undefined;
  /**
   * Hosts that are not connected: their sessions are the last list read, and nothing can be done with them. They wait
   * for no one and work for no one, so they are in their projects and not in Needs you or Working.
   */
  away?: ReadonlySet<string> | undefined;
};

/** A session, among the sessions of every host: the pair (host, id) is what is unique. */
export const sessionKey = (session: SessionSummary): string =>
  viewKey(session.hostId, session.sessionId);

/** A project is a folder on one host (a host's id has no "|" in it, so the first one ends it). */
export const projectKey = (session: SessionSummary): string =>
  `${session.hostId}|${projectOf(session)}`;

/** The folder a session belongs to as a project: without a trailing slash (`/a/app` and `/a/app/` are one). */
export const projectOf = (session: SessionSummary): string => {
  const trimmed = session.cwd.replace(/\/+$/, "");
  return trimmed === "" ? (session.cwd.startsWith("/") ? "/" : "") : trimmed;
};

const before = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const timeOf = (session: SessionSummary): number =>
  session.updatedAt === undefined ? Number.NaN : Date.parse(session.updatedAt);

/**
 * Newest first. By `updatedAt`, which compares across hosts. A session whose daemon does not say (an older one) comes
 * after those that have it, and those are ordered by `lastSeq`, which only compares within one daemon: so they stay
 * in their daemon's order, and are never mixed in with another's by a number that means something else.
 */
const younger = (a: SessionSummary, b: SessionSummary): number => {
  const left = timeOf(a);
  const right = timeOf(b);
  if (!Number.isNaN(left) && !Number.isNaN(right) && left !== right) return right - left;
  if (Number.isNaN(left) !== Number.isNaN(right)) return Number.isNaN(left) ? 1 : -1;
  // `lastSeq` only means something within one daemon: across daemons the tie stays a tie (group by host first).
  return before(a.hostId, b.hostId) || b.lastSeq - a.lastSeq;
};

export const newest = (a: SessionSummary, b: SessionSummary): number =>
  younger(a, b) || before(a.hostId, b.hostId) || before(a.sessionId, b.sessionId);

const parts = (folder: string): string[] => folder.split("/").filter(Boolean);

type Project = { key: string; folder: string; hostId: string };

/**
 * The names of the projects: the last part of the folder, with more of it only where two on the same host would be
 * the same; then, for a project on another host, that host's name.
 */
const namesOf = (
  projects: readonly Project[],
  hosts: ReadonlyMap<string, HostLabel>,
): Map<string, string> => {
  const segments = new Map(projects.map((p) => [p.key, parts(p.folder)]));
  const depth = new Map(projects.map((p) => [p.key, 1]));
  const label = (project: Project): string => {
    const all = segments.get(project.key) ?? [];
    const take = depth.get(project.key) ?? 1;
    // At most the whole path, which no other folder has.
    return all.length === 0 ? project.folder : all.slice(-take).join("/");
  };
  for (let round = 0; round < 64; round += 1) {
    const byLabel = new Map<string, Project[]>();
    for (const project of projects) {
      const same = `${project.hostId}|${label(project)}`;
      byLabel.set(same, [...(byLabel.get(same) ?? []), project]);
    }
    let grew = false;
    for (const same of byLabel.values()) {
      if (same.length < 2) continue;
      for (const project of same) {
        if ((depth.get(project.key) ?? 1) < (segments.get(project.key)?.length ?? 0)) {
          depth.set(project.key, (depth.get(project.key) ?? 1) + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Map(
    projects.map((project) => {
      const host = hosts.get(project.hostId);
      const name = label(project);
      if (host === undefined || host.local) return [project.key, name];
      return [project.key, name === "" ? host.name : `${name} · ${host.name}`];
    }),
  );
};

export const sessionList = (
  sessions: readonly SessionSummary[],
  { showArchived, showAll, selected, hosts, away }: SessionListOptions,
): SessionList => {
  const shown = sessions.filter((s) => showArchived || !s.archived).toSorted(newest);
  // An archived session is put away: it waits for no one, and is not "working" even if its state says so.
  const live = (s: SessionSummary) => !s.archived && away?.has(s.hostId) !== true;
  const needs = shown.filter((s) => live(s) && s.state === "requires_action");
  const working = shown.filter((s) => live(s) && s.state === "running");
  const apart = new Set([...needs, ...working]);
  const byProject = new Map<string, SessionSummary[]>();
  for (const session of shown) {
    if (apart.has(session)) continue;
    const key = projectKey(session);
    const list = byProject.get(key);
    if (list === undefined) byProject.set(key, [session]);
    else list.push(session);
  }
  const known = new Map<string, Project>();
  for (const session of shown) {
    known.set(projectKey(session), {
      key: projectKey(session),
      folder: projectOf(session),
      hostId: session.hostId,
    });
  }
  const names = namesOf([...known.values()], new Map((hosts ?? []).map((h) => [h.id, h])));
  const projects = [...byProject].toSorted(([a, left], [b, right]) => {
    const l = left[0];
    const r = right[0];
    return (l !== undefined && r !== undefined ? younger(l, r) : 0) || before(a, b);
  });
  // The open session's project shows it, however far down it is, and by where the session stands among that folder's
  // sessions whatever its state: so the list does not grow and shrink as the session moves between Working and its project.
  const open = shown.find((s) => sessionKey(s) === selected);
  const openFolder = open === undefined ? undefined : projectKey(open);
  const openAt =
    open === undefined ? 0 : shown.filter((s) => projectKey(s) === openFolder).indexOf(open) + 1;
  const groups: SessionGroup[] = [];
  if (needs.length > 0)
    groups.push({ key: "needs-you", kind: "needs-you", label: "", sessions: needs, hidden: 0 });
  if (working.length > 0)
    groups.push({ key: "working", kind: "working", label: "", sessions: working, hidden: 0 });
  let hidden = 0;
  for (const [key, all] of projects) {
    const limit = showAll ? all.length : Math.max(PER_PROJECT, key === openFolder ? openAt : 0);
    const list = all.slice(0, limit);
    hidden += all.length - list.length;
    groups.push({
      key: `project:${key}`,
      kind: "project",
      label: names.get(key) ?? "",
      sessions: list,
      hidden: all.length - list.length,
    });
  }
  return { groups, order: groups.flatMap((g) => g.sessions), hidden, names };
};
