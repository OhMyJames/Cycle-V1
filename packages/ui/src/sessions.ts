// How the sessions are put in front of the person: which workspace the sidebar shows, how its sessions are grouped and
// ordered, what each row says, and what the switcher says of the other workspaces. Pure, so the list on screen and the
// keyboard walking it (Cmd+[ and Cmd+]) are one thing and are tested without a page. `now` is given, never read.
//
// A workspace is a folder on one host: `(hostId, cwd)` (docs/desktop.md). The sidebar shows one at a time.
import type { SessionSummary } from "./api.ts";
import { viewKey } from "./store/store.ts";

/** How many of a workspace's older sessions show before "Show more". */
export const PER_WORKSPACE = 20;

/** What is on a row, most urgent first: the one thing a row says of its session. */
export type Mark = "needs-you" | "running" | "background" | "unread";
const URGENCY: readonly Mark[] = ["needs-you", "running", "background", "unread"];

export type Counts = Record<Mark, number>;

export type SessionGroup = {
  /** Unique among the groups, and the same from one call to the next. */
  key: string;
  kind: "needs-you" | "running" | "today" | "yesterday" | "earlier";
  /** What is shown. */
  sessions: SessionSummary[];
};

export type SessionList = {
  groups: SessionGroup[];
  /** The sessions shown, in the order they are on screen. */
  order: SessionSummary[];
  /** How many sessions are not shown because of the limit. */
  hidden: number;
};

/** What the list needs to know of a host. */
export type HostLabel = { id: string; name: string; local: boolean };

/** A session, among the sessions of every host: the pair (host, id) is what is unique. */
export const sessionKey = (session: SessionSummary): string =>
  viewKey(session.hostId, session.sessionId);

/** A workspace is a folder on one host (a host's id has no "|" in it, so the first one ends it). */
export const workspaceKey = (session: SessionSummary): string =>
  `${session.hostId}|${folderOf(session)}`;

/** The folder a session works in, without a trailing slash (`/a/app` and `/a/app/` are one). */
export const folderOf = (session: SessionSummary): string => {
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

/**
 * What a row says of its session, one thing: waiting for the person, working, a background sub-agent working, or news
 * the person has not seen. An archived session is put away and a session of a host that is away is the last list read:
 * neither waits for anyone nor works for anyone.
 */
export const markOf = (session: SessionSummary, away?: ReadonlySet<string>): Mark | undefined => {
  if (session.archived || away?.has(session.hostId) === true) return undefined;
  if (session.state === "requires_action") return "needs-you";
  if (session.state === "running") return "running";
  if ((session.background ?? 0) > 0) return "background";
  if (session.unread === true) return "unread";
  return undefined;
};

const noCounts = (): Counts => ({ "needs-you": 0, running: 0, background: 0, unread: 0 });

export type Workspace = {
  key: string;
  hostId: string;
  cwd: string;
  /** The folder's name; more of the path where two on one host would be the same, and the host's name where two hosts would. */
  name: string;
  /** Its sessions, newest first (those that are archived only when asked for). */
  sessions: SessionSummary[];
  counts: Counts;
};

/**
 * Every workspace: grouped by host (this computer first, then in the order the hosts are listed), and inside a host the
 * one with the newest session first. A workspace with only archived sessions is there only when they are asked for.
 */
export const workspacesOf = (
  sessions: readonly SessionSummary[],
  {
    hosts = [],
    away,
    showArchived = false,
  }: {
    hosts?: readonly HostLabel[] | undefined;
    away?: ReadonlySet<string> | undefined;
    showArchived?: boolean | undefined;
  } = {},
): Workspace[] => {
  const byKey = new Map<string, SessionSummary[]>();
  for (const session of sessions.toSorted(newest)) {
    if (session.archived && !showArchived) continue;
    const list = byKey.get(workspaceKey(session));
    if (list === undefined) byKey.set(workspaceKey(session), [session]);
    else list.push(session);
  }
  const known = [...byKey].map(([key, list]) => ({
    key,
    hostId: list[0]?.hostId ?? "",
    cwd: list[0] !== undefined ? folderOf(list[0]) : "",
    sessions: list,
  }));
  const names = namesOf(known, hosts);
  const rank = (hostId: string): number => {
    const at = hosts.findIndex((h) => h.id === hostId);
    const local = hosts[at]?.local === true;
    return local ? -1 : at === -1 ? hosts.length : at;
  };
  return known
    .map((w): Workspace => {
      const counts = noCounts();
      for (const session of w.sessions) {
        const mark = markOf(session, away);
        if (mark !== undefined) counts[mark] += 1;
      }
      return { ...w, name: names.get(w.key) ?? "", counts };
    })
    .toSorted((a, b) => {
      const left = a.sessions[0];
      const right = b.sessions[0];
      return (
        rank(a.hostId) - rank(b.hostId) ||
        (left !== undefined && right !== undefined ? younger(left, right) : 0) ||
        before(a.key, b.key)
      );
    });
};

const parts = (folder: string): string[] => folder.split("/").filter(Boolean);

/**
 * The names of the workspaces: the last part of the folder, with more of it only where two on the same host would be
 * the same; and where two on different hosts would still be the same, the host's name after it.
 */
const namesOf = (
  workspaces: readonly { key: string; hostId: string; cwd: string }[],
  hosts: readonly HostLabel[],
): Map<string, string> => {
  const segments = new Map(workspaces.map((w) => [w.key, parts(w.cwd)]));
  const depth = new Map(workspaces.map((w) => [w.key, 1]));
  const label = (w: { key: string; cwd: string }): string => {
    const all = segments.get(w.key) ?? [];
    const take = depth.get(w.key) ?? 1;
    // At most the whole path, which no other folder has.
    return all.length === 0 ? w.cwd : all.slice(-take).join("/");
  };
  for (let round = 0; round < 64; round += 1) {
    const byLabel = new Map<string, typeof workspaces>();
    for (const w of workspaces) {
      const same = `${w.hostId}|${label(w)}`;
      byLabel.set(same, [...(byLabel.get(same) ?? []), w]);
    }
    let grew = false;
    for (const same of byLabel.values()) {
      if (same.length < 2) continue;
      for (const w of same) {
        if ((depth.get(w.key) ?? 1) < (segments.get(w.key)?.length ?? 0)) {
          depth.set(w.key, (depth.get(w.key) ?? 1) + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  const taken = new Map<string, number>();
  for (const w of workspaces) taken.set(label(w), (taken.get(label(w)) ?? 0) + 1);
  return new Map(
    workspaces.map((w) => {
      const name = label(w);
      const host = hosts.find((h) => h.id === w.hostId);
      const clash = (taken.get(name) ?? 0) > 1 && host !== undefined;
      return [w.key, name === "" ? (host?.name ?? "") : clash ? `${name} · ${host.name}` : name];
    }),
  );
};

/**
 * The workspace the sidebar shows: the one the person chose in the switcher (until they open something else), then the
 * one the open session is in, then the one that had something happen most recently.
 */
export const currentWorkspace = (
  workspaces: readonly Workspace[],
  { chosen, open }: { chosen?: string | undefined; open?: SessionSummary | undefined },
): Workspace | undefined => {
  const named = (key: string | undefined) =>
    key === undefined ? undefined : workspaces.find((w) => w.key === key);
  const recent = workspaces
    .map((w) => w.sessions[0])
    .filter((s): s is SessionSummary => s !== undefined)
    .toSorted(newest)[0];
  return (
    named(chosen) ?? (open && named(workspaceKey(open))) ?? named(recent && workspaceKey(recent))
  );
};

export type Elsewhere = {
  /** The most urgent thing going on in the other workspaces, and how many sessions it is. */
  mark: Mark | undefined;
  count: number;
  counts: Counts;
};

/** What the switcher says of the workspaces that are not shown. */
export const elsewhere = (
  workspaces: readonly Workspace[],
  current: Workspace | undefined,
): Elsewhere => {
  const counts = noCounts();
  for (const w of workspaces) {
    if (w.key === current?.key) continue;
    for (const mark of URGENCY) counts[mark] += w.counts[mark];
  }
  const mark = URGENCY.find((m) => counts[m] > 0);
  return { mark, count: mark === undefined ? 0 : counts[mark], counts };
};

/** The day a time is in, by the local clock: 0 today, 1 yesterday, more before. */
const daysAgo = (time: number, now: Date): number => {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const then = new Date(time);
  const a = new Date(day(now));
  const b = new Date(day(then));
  // Whole days between two local midnights, whatever the length of the days in between.
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
};

export type SessionListOptions = {
  /** Lifts the limit. */
  showAll: boolean;
  /** The open session, by its `sessionKey`: shown however far down it is. */
  selected?: string | undefined;
  /** Hosts that are not connected: their sessions are the last list read, and wait for no one. */
  away?: ReadonlySet<string> | undefined;
  now: Date;
};

/**
 * One workspace's sessions: what waits on the person, what is working (and what has a sub-agent working), then the
 * rest by the day they last had something happen. Only the older ones are limited: a session with something to say, and
 * the open one, are always shown.
 */
export const sessionList = (
  sessions: readonly SessionSummary[],
  { showAll, selected, away, now }: SessionListOptions,
): SessionList => {
  const sorted = sessions.toSorted(newest);
  const groups: SessionGroup[] = [];
  const needs = sorted.filter((s) => markOf(s, away) === "needs-you");
  const busy = sorted.filter((s) => {
    const mark = markOf(s, away);
    return mark === "running" || mark === "background";
  });
  const apart = new Set([...needs, ...busy]);
  if (needs.length > 0) groups.push({ key: "needs-you", kind: "needs-you", sessions: needs });
  if (busy.length > 0) groups.push({ key: "running", kind: "running", sessions: busy });
  const rest = sorted.filter((s) => !apart.has(s));
  let shown = 0;
  let hidden = 0;
  for (const kind of ["today", "yesterday", "earlier"] as const) {
    const day = rest.filter((s) => {
      const time = timeOf(s);
      const ago = Number.isNaN(time) ? 2 : Math.min(2, Math.max(0, daysAgo(time, now)));
      return (ago === 0 ? "today" : ago === 1 ? "yesterday" : "earlier") === kind;
    });
    const list = day.filter((s) => {
      const keep =
        showAll ||
        shown < PER_WORKSPACE ||
        markOf(s, away) !== undefined ||
        sessionKey(s) === selected;
      if (keep) shown += 1;
      else hidden += 1;
      return keep;
    });
    if (list.length > 0) groups.push({ key: kind, kind, sessions: list });
  }
  return { groups, order: groups.flatMap((g) => g.sessions), hidden };
};
