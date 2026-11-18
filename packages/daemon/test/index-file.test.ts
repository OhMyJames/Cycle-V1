import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IndexUnreadableError, SessionIndex } from "../src/index.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(() => dispose());

const entry = {
  agent: "claude",
  agentSessionId: "a1",
  cwd: "/work",
  createdAt: "2026-11-18T00:00:00.000Z",
};

test("starts empty when there is no file", async () => {
  const index = await SessionIndex.load(join(dir, "index.json"));
  expect(index.list()).toEqual([]);
});

test("keeps what is put in it across a reload", async () => {
  const path = join(dir, "index.json");
  const index = await SessionIndex.load(path);
  await index.put("s1", entry);
  await index.update("s1", { title: "hello", archived: true });
  const again = await SessionIndex.load(path);
  expect(again.get("s1")).toEqual({ ...entry, title: "hello", archived: true });
  await again.delete("s1");
  expect((await SessionIndex.load(path)).list()).toEqual([]);
});

test("leaves no temporary file behind", async () => {
  const index = await SessionIndex.load(join(dir, "index.json"));
  await index.put("s1", entry);
  expect(await readdir(dir)).toEqual(["index.json"]);
});

test("refuses an index it cannot read, and does not touch it", async () => {
  const path = join(dir, "index.json");
  await writeFile(path, "{ not json");
  await expect(SessionIndex.load(path)).rejects.toBeInstanceOf(IndexUnreadableError);
  expect(await Bun.file(path).text()).toBe("{ not json");
});

test("refuses an index of the wrong shape", async () => {
  const path = join(dir, "index.json");
  await writeFile(path, JSON.stringify({ version: 2, sessions: {} }));
  await expect(SessionIndex.load(path)).rejects.toBeInstanceOf(IndexUnreadableError);
});

test("a change that fails leaves the index as it was", async () => {
  const index = await SessionIndex.load(join(dir, "index.json"));
  await index.put("s1", entry);
  await expect(index.update("missing", { title: "x" })).rejects.toBeDefined();
  expect(index.list().map(([id]) => id)).toEqual(["s1"]);
});
