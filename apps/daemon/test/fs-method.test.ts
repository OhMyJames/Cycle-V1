import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { Daemon } from "../src/index.ts";
import { connectClient } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { gitIn, tempDir } from "./support.ts";

let dir: string;
let work: string;
let dispose: () => Promise<void>;
let disposeWork: () => Promise<void>;
let open: Daemon[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
  ({ dir: work, dispose: disposeWork } = await tempDir());
  work = await realpath(work);
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  await dispose();
  await disposeWork();
});

type Entry = { name: string; kind: string; ignored?: boolean };

test("the daemon says it can show files, lists and reads the session's folder, and marks ignored only when trusted", async () => {
  await writeFile(join(work, ".gitignore"), "*.log\n");
  await writeFile(join(work, "run.log"), "");
  await mkdir(join(work, "src"));
  await writeFile(join(work, "src", "main.ts"), "let x = 1;\n");
  gitIn(work, "init", "-q");
  const daemon = await Daemon.start({ dataDir: dir, agents: [fakeAgent().definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  expect((c.init._meta as Record<string, { fs?: boolean }>)["cycle/capabilities"]?.fs).toBe(true);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: work });
  const list = (path: string) =>
    c.agent.request("_cycle/fs/list" as never, { sessionId, path } as never) as Promise<{
      root: string;
      entries: Entry[];
    }>;
  const read = (params: object) =>
    c.agent.request(
      "_cycle/fs/read" as never,
      { sessionId, ...params } as never,
    ) as Promise<unknown>;

  // No decision on the folder: git is not run, and nothing is said about what it ignores.
  const untrusted = await list("");
  expect(untrusted.root).toBe(work);
  expect(untrusted.entries.map((e) => e.name)).toEqual(["src", ".gitignore", "run.log"]);
  expect(untrusted.entries.some((e) => "ignored" in e)).toBe(false);

  await c.agent.request("_cycle/trust/set" as never, { path: work, trusted: true } as never);
  expect((await list("")).entries.find((e) => e.name === "run.log")?.ignored).toBe(true);

  expect(await read({ path: "src/main.ts" })).toMatchObject({
    kind: "text",
    text: "let x = 1;\n",
    next: null,
  });
  await expect(read({ path: "../x" })).rejects.toMatchObject({ code: -32602 });
  await expect(read({ path: "nope.ts" })).rejects.toMatchObject({ code: -32002 });
  await expect(
    c.agent.request("_cycle/fs/list" as never, { sessionId: "nope", path: "" } as never),
  ).rejects.toMatchObject({ code: -32002 });
});
