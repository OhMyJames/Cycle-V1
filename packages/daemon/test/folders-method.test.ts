import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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

test("the daemon says it can list folders, needs no session to do it, and refuses what is not a folder", async () => {
  await mkdir(join(work, "app"));
  await mkdir(join(work, ".cache"));
  const daemon = await Daemon.start({ dataDir: dir, agents: [fakeAgent().definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  const capabilities = (c.init._meta as Record<string, { folders?: boolean }>)[
    "cycle/capabilities"
  ];
  expect(capabilities?.folders).toBe(true);
  const listed = (await c.agent.request(
    "_cycle/folders/list" as never,
    { path: work } as never,
  )) as {
    path: string;
    folders: { name: string }[];
    truncated: boolean;
  };
  expect(listed.folders).toEqual([{ name: "app" }]);
  expect(listed.truncated).toBe(false);
  const withHidden = (await c.agent.request(
    "_cycle/folders/list" as never,
    { path: work, hidden: true } as never,
  )) as { folders: { name: string }[] };
  expect(withHidden.folders.map((f) => f.name)).toEqual([".cache", "app"]);
  await expect(
    c.agent.request("_cycle/folders/list" as never, { path: "relative" } as never),
  ).rejects.toMatchObject({ code: -32602 });
});
