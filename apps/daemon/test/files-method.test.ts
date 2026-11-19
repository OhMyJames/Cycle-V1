import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { Daemon } from "../src/index.ts";
import { connectClient } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let work: string;
let dispose: () => Promise<void>;
let disposeWork: () => Promise<void>;
let open: Daemon[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
  ({ dir: work, dispose: disposeWork } = await tempDir());
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  await dispose();
  await disposeWork();
});

test("the daemon says it can search, and finds files in the session's folder, which it names", async () => {
  await mkdir(join(work, "src"), { recursive: true });
  await writeFile(join(work, "src", "main.ts"), "x");
  const daemon = await Daemon.start({ dataDir: dir, agents: [fakeAgent().definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  expect((c.init._meta as Record<string, { files?: boolean }>)["cycle/capabilities"]?.files).toBe(
    true,
  );
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: work });
  const found = (await c.agent.request(
    "_cycle/files/search" as never,
    {
      sessionId,
      query: "main",
    } as never,
  )) as { root: string; entries: unknown[]; truncated: boolean };
  expect(found).toEqual({
    root: work,
    entries: [{ path: "src/main.ts", kind: "file" }],
    truncated: false,
  });
  await expect(
    c.agent.request("_cycle/files/search" as never, { sessionId: "nope", query: "a" } as never),
  ).rejects.toMatchObject({ code: -32002 });
  await expect(
    c.agent.request("_cycle/files/search" as never, { sessionId, query: "a", limit: 500 } as never),
  ).rejects.toMatchObject({ code: -32602 });
});

test("a conversation with no session yet searches the folder it chose, by the same rules", async () => {
  await mkdir(join(work, "src"), { recursive: true });
  await writeFile(join(work, "src", "main.ts"), "x");
  const daemon = await Daemon.start({ dataDir: dir, agents: [fakeAgent().definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  expect(
    (c.init._meta as Record<string, { filesInFolder?: boolean }>)["cycle/capabilities"]
      ?.filesInFolder,
  ).toBe(true);
  const search = (params: object) =>
    c.agent.request("_cycle/files/search" as never, params as never) as Promise<unknown>;
  expect(await search({ cwd: work, query: "main" })).toEqual({
    root: work,
    entries: [{ path: "src/main.ts", kind: "file" }],
    truncated: false,
  });
  // A folder that is not there has nothing in it, as for a session.
  expect(await search({ cwd: join(work, "gone"), query: "" })).toEqual({
    root: join(work, "gone"),
    entries: [],
    truncated: false,
  });
  // Exactly one of the two, and a path that is absolute.
  await expect(search({ cwd: "src", query: "a" })).rejects.toMatchObject({ code: -32602 });
  await expect(search({ query: "a" })).rejects.toMatchObject({ code: -32602 });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: work });
  await expect(search({ sessionId, cwd: work, query: "a" })).rejects.toMatchObject({
    code: -32602,
  });
});
