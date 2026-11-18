// The packaged app, as a user's machine would run it: assembled by scripts/package.ts (or given, in
// CYCLE_PACKAGED_APP, as the workflow does for the bundle it just built), started with a bare
// environment (no bun or node on PATH, no repository). It must find the daemon and Claude inside
// itself, start the daemon, and show a window that is connected to it.
//
// The window is read over the DevTools protocol, which Electron serves when asked
// (--remote-debugging-port): the page's own host indicator has to say "connected".
// Linux (under xvfb) and macOS run the same test; what differs is only where the executable is.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageApp } from "../../scripts/package.ts";

const linux = process.platform === "linux";
const mac = process.platform === "darwin";
const ready = mac || (linux && Bun.which("xvfb-run") !== null);

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-packaged-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** Where the pieces are, for an app that was built here or one that was handed in. */
const locate = () => {
  const given = process.env.CYCLE_PACKAGED_APP;
  if (given === undefined) return packageApp(join(root, "build"));
  const appDir = mac ? join(given, "Contents/Resources/app") : join(given, "resources/app");
  const executable = mac ? join(given, "Contents/MacOS/Electron") : join(given, "cycle");
  return { app: given, appDir, executable, version: "" };
};

/** Asks the page, over the DevTools protocol, to evaluate an expression. */
const evaluate = async (port: number, expression: string): Promise<unknown> => {
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = pages.find((p) => p.type === "page");
  if (page === undefined) throw new Error("no page yet");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("devtools socket failed"));
  });
  try {
    return await new Promise((resolve, reject) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          result?: { result?: { value?: unknown } };
        };
        if (message.id === 1) resolve(message.result?.result?.value);
      };
      socket.onerror = () => reject(new Error("devtools socket failed"));
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        }),
      );
    });
  } finally {
    socket.close();
  }
};

test.skipIf(!ready)(
  "the packaged app starts the daemon it carries, and its window connects to it",
  async () => {
    const packaged = locate();
    expect(existsSync(join(packaged.appDir, "build.json"))).toBe(true);
    expect(existsSync(join(packaged.appDir, "bin/claude"))).toBe(true);

    const data = join(root, "data");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const flags = [
      "--no-sandbox", // the test machine has no setuid chrome-sandbox; the window itself stays sandboxed
      "--disable-gpu",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(root, "electron")}`,
    ];
    const proc = Bun.spawn(
      linux ? ["xvfb-run", "-a", packaged.executable, ...flags] : [packaged.executable, ...flags],
      {
        env: { PATH: "/usr/bin:/bin", HOME: root, CYCLE_V1_HOME: data },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      // The window says it is connected: the page, the main process and the bundled daemon, together.
      const started = Date.now();
      let state: unknown;
      for (;;) {
        state = await evaluate(
          port,
          "document.querySelector('[data-slot=\"host-state\"]')?.textContent ?? null",
        ).catch(() => undefined);
        if (state === "connected") break;
        if (Date.now() - started > 45_000) {
          throw new Error(`the window never said connected (last: ${String(state)})`);
        }
        await Bun.sleep(250);
      }
      // And the daemon that serves it is the one inside the app.
      const pid = Number((await Bun.file(join(data, "daemon.pid")).text()).trim());
      if (linux)
        expect(await readlink(`/proc/${pid}/exe`)).toBe(join(packaged.appDir, "bin/cycle-daemon"));
      else {
        const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
        expect(ps.stdout.toString()).toContain(join(packaged.appDir, "bin/cycle-daemon"));
      }
      process.kill(pid, "SIGTERM");
    } finally {
      proc.kill();
      await proc.exited;
    }
  },
  120_000,
);
