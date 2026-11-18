import { expect, test } from "bun:test";
import type { SessionSummary } from "../src/api.ts";
import { PER_PROJECT, projectOf, sessionList } from "../src/sessions.ts";

const row = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  hostId: "local",
  sessionId: id,
  cwd: "/work/app",
  archived: false,
  agent: "claude",
  state: "idle",
  lastSeq: 1,
  ...over,
});
const plain = { showArchived: false, showAll: false };
const ids = (list: ReturnType<typeof sessionList>) => list.order.map((s) => s.sessionId);

test("what waits on the person comes first, then what is working, then the projects", () => {
  const list = sessionList(
    [
      row("old", { lastSeq: 1 }),
      row("run", { state: "running", lastSeq: 5 }),
      row("ask", { state: "requires_action", lastSeq: 2 }),
      row("new", { lastSeq: 9 }),
    ],
    plain,
  );
  expect(list.groups.map((g) => g.kind)).toEqual(["needs-you", "working", "project"]);
  expect(ids(list)).toEqual(["ask", "run", "new", "old"]);
});

test("a session is in one group only, and a project's sessions are newest first", () => {
  const list = sessionList(
    [row("a", { lastSeq: 1 }), row("b", { lastSeq: 3 }), row("c", { state: "running" })],
    plain,
  );
  expect(ids(list).sort()).toEqual(["a", "b", "c"]);
  expect(list.groups.at(-1)?.sessions.map((s) => s.sessionId)).toEqual(["b", "a"]);
});

test("projects are ordered by their newest session, and a name is longer only where two would clash", () => {
  const list = sessionList(
    [
      row("1", { cwd: "/home/a/app", lastSeq: 1 }),
      row("2", { cwd: "/home/b/app", lastSeq: 5 }),
      row("3", { cwd: "/home/a/tool", lastSeq: 3 }),
    ],
    plain,
  );
  expect(list.groups.map((g) => g.label)).toEqual(["b/app", "tool", "a/app"]);
});

test("archived sessions are not shown unless asked for, and are never 'working'", () => {
  const rows = [row("a"), row("z", { archived: true, state: "running", lastSeq: 9 })];
  expect(ids(sessionList(rows, plain))).toEqual(["a"]);
  const all = sessionList(rows, { ...plain, showArchived: true });
  expect(all.groups.map((g) => g.kind)).toEqual(["project"]);
  expect(ids(all)).toEqual(["z", "a"]);
});

test("a project shows a page of its sessions and says how many more it has", () => {
  const rows = Array.from({ length: PER_PROJECT + 5 }, (_, n) => row(`s${n}`, { lastSeq: n }));
  const list = sessionList(rows, plain);
  expect(list.order).toHaveLength(PER_PROJECT);
  expect(list.hidden).toBe(5);
  expect(list.groups[0]?.hidden).toBe(5);
  expect(sessionList(rows, { ...plain, showAll: true }).order).toHaveLength(PER_PROJECT + 5);
});

test("the open session is shown however far down its project it is", () => {
  const rows = Array.from({ length: PER_PROJECT + 5 }, (_, n) => row(`s${n}`, { lastSeq: n }));
  const list = sessionList(rows, { ...plain, selected: "s0" });
  expect(ids(list)).toContain("s0");
  expect(list.hidden).toBe(0);
});

test("the open session is shown, and its project is not opened any further than that", () => {
  const rows = Array.from({ length: 300 }, (_, n) => row(`s${n}`, { lastSeq: n }));
  const list = sessionList(rows, { ...plain, selected: "s279" });
  // s279 is the 21st newest: the page, plus one.
  expect(list.order).toHaveLength(PER_PROJECT + 1);
  expect(list.order.at(-1)?.sessionId).toBe("s279");
  // An open one on the first page changes nothing.
  expect(sessionList(rows, { ...plain, selected: "s299" }).order).toHaveLength(PER_PROJECT);
});

test("the open session in Working leaves its project the same size as when it is in it", () => {
  const rows = Array.from({ length: 300 }, (_, n) => row(`s${n}`, { lastSeq: n }));
  const idle = sessionList(rows, { ...plain, selected: "s250" });
  const running = sessionList(
    rows.map((r) => (r.sessionId === "s250" ? { ...r, state: "running" as const } : r)),
    { ...plain, selected: "s250" },
  );
  const project = (list: ReturnType<typeof sessionList>) => list.groups.at(-1)?.sessions.length;
  // In the project it is the 50th row; running, it is in Working, and the project is still as long: it does not jump.
  expect(project(idle)).toBe(50);
  expect(project(running)).toBe(50);
});

test("an open session that is not in the list changes nothing", () => {
  const rows = Array.from({ length: 30 }, (_, n) => row(`s${n}`, { lastSeq: n }));
  expect(sessionList(rows, { ...plain, selected: "nobody" }).order).toHaveLength(PER_PROJECT);
  const archived = [...rows, row("gone", { archived: true, lastSeq: 0 })];
  expect(sessionList(archived, { ...plain, selected: "gone" }).order).toHaveLength(PER_PROJECT);
});

test("a folder with a trailing slash is the same project, and the root and an empty folder are named", () => {
  expect(projectOf(row("a", { cwd: "/a/app/" }))).toBe("/a/app");
  expect(projectOf(row("a", { cwd: "/" }))).toBe("/");
  expect(projectOf(row("a", { cwd: "" }))).toBe("");
  const list = sessionList([row("1", { cwd: "/a/app" }), row("2", { cwd: "/a/app/" })], plain);
  expect(list.groups).toHaveLength(1);
});

test("project names are made longer until no two are the same", () => {
  const list = sessionList(
    [
      row("1", { cwd: "/a/x/app", lastSeq: 3 }),
      row("2", { cwd: "/b/x/app", lastSeq: 2 }),
      row("3", { cwd: "/c/y/app", lastSeq: 1 }),
      row("4", { cwd: "/d/tool", lastSeq: 0 }),
    ],
    plain,
  );
  const labels = list.groups.map((g) => g.label);
  expect(new Set(labels).size).toBe(labels.length);
  expect(labels).toContain("tool");
  expect(labels).toContain("a/x/app");
  expect(labels).toContain("y/app");
});

test("the names of the projects are given for every session, also those in Working", () => {
  const list = sessionList(
    [row("1", { cwd: "/a/app", state: "running" }), row("2", { cwd: "/b/app" })],
    plain,
  );
  expect(list.names.get("/a/app")).toBe("a/app");
  expect(list.names.get("/b/app")).toBe("b/app");
});

test("projects with the same newest session are ordered by their folder, and the list is the same every time", () => {
  const rows = [row("1", { cwd: "/b", lastSeq: 1 }), row("2", { cwd: "/a", lastSeq: 1 })];
  expect(sessionList(rows, plain).groups.map((g) => g.label)).toEqual(["a", "b"]);
});

test("an empty list has no groups, and the order is the same call after call", () => {
  expect(sessionList([], plain)).toEqual({ groups: [], order: [], hidden: 0, names: new Map() });
  const rows = [row("a", { lastSeq: 1 }), row("b", { lastSeq: 1 })];
  expect(ids(sessionList(rows, plain))).toEqual(ids(sessionList([...rows].reverse(), plain)));
});
