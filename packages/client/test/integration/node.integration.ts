// Proves the client half works under Node. Bun passing its own tests proves nothing about that.
// Run with `bun run test:integration` in packages/client. It needs Electron's binary (see
// docs/desktop.md): Electron carries a real Node, which is what the desktop app's main process is.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "@cycle/daemon";
import { listenUnix } from "@cycle/transport/server";
import { electronBinary } from "../../../../scripts/electron-binary.ts";
import { fakeAgent } from "../../../daemon/test/fake-agent.ts";

const electron = electronBinary(new URL("../../../../node_modules/.bun", import.meta.url).pathname);

let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.reverse()) await clean();
  cleanup = [];
});

test.skipIf(electron === undefined || !existsSync(electron))(
  "CycleClient and the client transport run under Node",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cv1-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const daemon = await Daemon.start({ dataDir: dir, agents: [fakeAgent().definition] });
    const socket = join(dir, "d.sock");
    const server = await listenUnix({
      path: socket,
      onConnection: ({ stream }) => void daemon.accept(stream),
    });
    cleanup.push(async () => {
      server.close();
      await daemon.close();
    });

    const built = await Bun.build({
      entrypoints: [new URL("./node-entry.ts", import.meta.url).pathname],
      target: "node",
      format: "esm",
    });
    expect(built.success).toBe(true);
    const script = join(dir, "node-entry.mjs");
    await Bun.write(script, (await built.outputs[0]?.text()) ?? "");

    const proc = Bun.spawn([electron as string, script, socket], {
      env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    if (proc.exitCode !== 0) console.log(err);
    expect(proc.exitCode).toBe(0);
    const result = JSON.parse(out.trim().split("\n").at(-1) as string);
    expect(result.node).toMatch(/^v\d+/);
    expect(result.bun).toBe("undefined");
    expect(result.sessions).toBe(1);
    expect(result.seen.map((s: { kind: string }) => s.kind)).toContain("agent_message_chunk");
    expect(result.seen.filter((s: { seq?: number }) => s.seq !== undefined).length).toBeGreaterThan(
      0,
    );
  },
  60_000,
);
