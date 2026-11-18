import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CycleErrorCode } from "@cycle/protocol";
import { JsonlLogStore } from "../src/index.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(() => dispose());

const store = () => new JsonlLogStore({ dir, now: () => new Date("2026-11-18T00:00:00Z") });

test("gives records seq 1, 2, 3 and writes one line each", async () => {
  const log = await store().open("s1");
  const a = await log.append({ kind: "meta", data: { event: "created" } });
  const b = await log.append({ kind: "update", data: { sessionUpdate: "agent_message_chunk" } });
  expect([a.seq, b.seq]).toEqual([1, 2]);
  expect(log.lastSeq()).toBe(2);
  const lines = (await readFile(join(dir, "s1.jsonl"), "utf8")).trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1] as string).seq).toBe(2);
  await log.close();
});

test("numbers concurrent appends without gaps or repeats", async () => {
  const log = await store().open("s1");
  const stored = await Promise.all(
    Array.from({ length: 50 }, (_, i) => log.append({ kind: "update", data: i })),
  );
  expect(stored.map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  expect((await log.read()).map((r) => r.data)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  await log.close();
});

test("reads a range", async () => {
  const log = await store().open("s1");
  for (let i = 0; i < 5; i++) await log.append({ kind: "update", data: i });
  expect((await log.read({ after: 2 })).map((r) => r.seq)).toEqual([3, 4, 5]);
  expect((await log.read({ after: 1, upTo: 3 })).map((r) => r.seq)).toEqual([2, 3]);
  await log.close();
});

test("carries on from where a closed log ended", async () => {
  const first = await store().open("s1");
  await first.append({ kind: "update", data: 1 });
  await first.append({ kind: "update", data: 2 });
  await first.close();
  const again = await store().open("s1");
  expect(again.lastSeq()).toBe(2);
  expect((await again.append({ kind: "update", data: 3 })).seq).toBe(3);
  await again.close();
});

test("cuts off half a line left by a crash, so the next record is not glued to it", async () => {
  const first = await store().open("s1");
  await first.append({ kind: "update", data: "kept" });
  await first.close();
  await appendFile(join(dir, "s1.jsonl"), '{"seq":2,"ts":"2026-11-18T00:00:00.000Z","ki');

  const again = await store().open("s1");
  expect(again.lastSeq()).toBe(1);
  const next = await again.append({ kind: "update", data: "after the crash" });
  expect(next.seq).toBe(2);
  await again.close();

  const text = await readFile(join(dir, "s1.jsonl"), "utf8");
  const lines = text.trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines.map((l) => JSON.parse(l).seq)).toEqual([1, 2]);
  expect(text.endsWith("\n")).toBe(true);
});

test("refuses a log with a gap in seq instead of skipping it", async () => {
  const line = (seq: number) =>
    JSON.stringify({ seq, ts: "2026-11-18T00:00:00.000Z", kind: "update", data: seq });
  await appendFile(join(dir, "s1.jsonl"), `${line(1)}\n${line(3)}\n`);
  await expect(store().open("s1")).rejects.toMatchObject({ code: CycleErrorCode.LogUnavailable });
});

test("refuses a line that is not JSON", async () => {
  await appendFile(join(dir, "s1.jsonl"), "not json\n");
  await expect(store().open("s1")).rejects.toMatchObject({ code: CycleErrorCode.LogUnavailable });
});

test("refuses to open the same log twice, and an id that is a path", async () => {
  const s = store();
  const log = await s.open("s1");
  await expect(s.open("s1")).rejects.toMatchObject({ code: CycleErrorCode.LogUnavailable });
  await expect(s.open("../escape")).rejects.toMatchObject({ code: CycleErrorCode.LogUnavailable });
  await log.close();
});

test("removes a closed log for good, and not an open one", async () => {
  const s = store();
  const log = await s.open("s1");
  await log.append({ kind: "update", data: 1 });
  await expect(s.remove("s1")).rejects.toBeDefined();
  await log.close();
  await s.remove("s1");
  expect(await s.exists("s1")).toBe(false);
});

test("updatedAt is the time of the last record that is not a meta one, and survives a reopen", async () => {
  let minute = 0;
  const ticking = () =>
    new JsonlLogStore({ dir, now: () => new Date(Date.UTC(2026, 10, 18, 0, minute++)) });
  const log = await ticking().open("s1");
  expect(log.updatedAt()).toBeUndefined();
  await log.append({ kind: "meta", data: { event: "created" } });
  expect(log.updatedAt()).toBeUndefined();
  const update = await log.append({
    kind: "update",
    data: { sessionUpdate: "agent_message_chunk" },
  });
  expect(log.updatedAt()).toBe(update.ts);
  await log.append({ kind: "meta", data: { event: "agent_exited" } });
  expect(log.updatedAt()).toBe(update.ts);
  await log.close();
  const again = await ticking().open("s1");
  expect(again.updatedAt()).toBe(update.ts);
  await again.close();
});
