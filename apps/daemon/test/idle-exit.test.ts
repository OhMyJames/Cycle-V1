// A served daemon with no client and nothing to do stops by itself (docs/daemon.md "空闲退出"), and not while a client
// is connected. The next `cycle proxy` starts it again (proxy.ts), so nothing here waits for a restart.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathsFor } from "../src/config.ts";
import { serve } from "../src/serve.ts";
import { isListening } from "../src/transport/server.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
let stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const stop of stops) await stop();
  stops = [];
  await dispose();
});

/** A daemon whose idle exit comes after `ms`, looked for every 10 ms. Resolves `exited` when it has stopped. */
const served = async (ms: number) => {
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({ idle: { exitMinutes: ms / 60_000, agentMinutes: 0 } }),
  );
  const paths = pathsFor(dir);
  let exited = false;
  const running = await serve(paths, { sweepMs: 10, idleExit: () => (exited = true) });
  stops.push(running.close);
  return { paths, exited: () => exited };
};

test("an idle daemon stops after the time given, and lets go of its socket and pid file", async () => {
  const { paths, exited } = await served(100);
  await Bun.sleep(30);
  expect(exited()).toBe(false);
  const deadline = Date.now() + 2_000;
  while (!exited() && Date.now() < deadline) await Bun.sleep(10);
  expect(exited()).toBe(true);
  expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
  expect(await isListening(paths.socket)).toBe(false);
});

test("a daemon with a client connected does not stop", async () => {
  const { paths, exited } = await served(50);
  const client = await Bun.connect({
    unix: paths.socket,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  await Bun.sleep(300);
  expect(exited()).toBe(false);
  // Once it has gone, the time counts from then.
  client.end();
  const deadline = Date.now() + 2_000;
  while (!exited() && Date.now() < deadline) await Bun.sleep(10);
  expect(exited()).toBe(true);
});

test("0 turns the idle exit off", async () => {
  await writeFile(join(dir, "config.json"), JSON.stringify({ idle: { exitMinutes: 0 } }));
  let exited = false;
  const running = await serve(pathsFor(dir), { sweepMs: 10, idleExit: () => (exited = true) });
  stops.push(running.close);
  await Bun.sleep(200);
  expect(exited).toBe(false);
});
