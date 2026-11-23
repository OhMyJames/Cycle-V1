import { afterEach, beforeEach, expect, test } from "bun:test";
import { realpath, writeFile } from "node:fs/promises";
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

test("the daemon says it can diff, and does only once the repository is trusted", async () => {
  gitIn(work, "init", "-q");
  await writeFile(join(work, "a.txt"), "1\n");
  gitIn(work, "add", "-A");
  gitIn(work, "commit", "-q", "-m", "base");
  await writeFile(join(work, "a.txt"), "2\n");
  const daemon = await Daemon.start({ dataDir: dir, agents: [fakeAgent().definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  expect((c.init._meta as Record<string, { diff?: boolean }>)["cycle/capabilities"]?.diff).toBe(
    true,
  );
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: work });
  const status = () =>
    c.agent.request("_cycle/diff/status" as never, { sessionId } as never) as Promise<unknown>;
  expect(await status()).toEqual({ state: "untrusted", repository: work });
  await c.agent.request("_cycle/trust/set" as never, { path: work, trusted: true } as never);
  expect(await status()).toMatchObject({
    state: "ok",
    files: [{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }],
  });
  expect(
    await c.agent.request("_cycle/diff/file" as never, { sessionId, path: "a.txt" } as never),
  ).toMatchObject({ path: "a.txt", binary: false, patch: expect.stringContaining("-1\n+2") });
  await expect(
    c.agent.request("_cycle/diff/status" as never, { sessionId: "nope" } as never),
  ).rejects.toMatchObject({ code: -32002 });
});
