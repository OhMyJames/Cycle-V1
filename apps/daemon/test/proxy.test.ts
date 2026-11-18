import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsFor } from "../src/config.ts";
import { logPath, proxy } from "../src/proxy.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-proxy-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const io = () => ({
  stdin: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
  stdout: new WritableStream<Uint8Array>(),
});

test("a daemon that cannot start is explained by what it wrote, which is kept in its log", async () => {
  const paths = pathsFor(join(dir, "data"));
  // A config the daemon cannot read: it exits at once, saying why.
  await Bun.write(paths.config, "{ not json");
  const started = Date.now();
  await expect(proxy(paths, io(), { total: 20_000, step: 25 })).rejects.toThrow(
    /did not start[\s\S]*config.json cannot be read/,
  );
  // It did not wait the time out: the daemon had already gone.
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(existsSync(logPath(paths))).toBe(true);
  expect(await readFile(logPath(paths), "utf8")).toContain("cannot be read");
}, 15_000);
