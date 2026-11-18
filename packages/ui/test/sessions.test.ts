import { expect, test } from "bun:test";
import type { SessionSummary } from "../src/api.ts";
import { PER_PROJECT, sessionList } from "../src/sessions.ts";

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

test("an empty list has no groups, and the order is the same call after call", () => {
  expect(sessionList([], plain)).toEqual({ groups: [], order: [], hidden: 0 });
  const rows = [row("a", { lastSeq: 1 }), row("b", { lastSeq: 1 })];
  expect(ids(sessionList(rows, plain))).toEqual(ids(sessionList([...rows].reverse(), plain)));
});
