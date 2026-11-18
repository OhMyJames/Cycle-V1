// The app, for real: Electron under xvfb, its real window driven with real mouse and key events,
// the real daemon (started by `proxy`), the Claude adapter, the real Agent SDK, a mock API.
// Run with `bun run build` and then `bun run test:integration` in apps/desktop. Not in the gate:
// it needs Electron's binary and xvfb.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startMock,
  textReply,
  toolReply,
} from "../../../../packages/adapters/claude/test/integration/mock-anthropic.ts";

const appDir = new URL("../..", import.meta.url).pathname;
const dist = join(appDir, "dist");
const daemonMain = join(appDir, "../daemon/src/main.ts");
const electron = (() => {
  const base = join(appDir, "../../node_modules/.bun");
  const found = Array.from(
    new Bun.Glob("electron@*/node_modules/electron/dist/electron").scanSync(base),
  );
  return found[0] === undefined ? undefined : join(base, found[0]);
})();
const xvfb = Bun.which("xvfb-run");
const ready =
  electron !== undefined &&
  existsSync(electron) &&
  xvfb !== null &&
  existsSync(join(dist, "main.mjs"));

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-smoke-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** The newest thing the user said, in a request to the model. */
const latestUserText = (body: unknown): string => {
  const messages = (
    (body as { messages?: { role: string; content: unknown }[] }).messages ?? []
  ).filter((m) => m.role === "user");
  const last = messages.at(-1)?.content;
  return typeof last === "string" ? last : JSON.stringify(last);
};

test.skipIf(!ready)(
  "a person can use the app: connect, start a session, chat, answer a permission, and reload",
  async () => {
    const mock = startMock((requests) => {
      const body = requests.at(-1)?.body;
      const text = latestUserText(body);
      if (JSON.stringify(body).includes("tool_result")) return textReply("All done.");
      if (text.includes("touch a file"))
        return toolReply("Bash", { command: "touch made-by-the-agent.txt" });
      return textReply("Hello from the mock.");
    });
    const data = join(root, "data");
    const home = join(root, "home");
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    await Bun.write(
      join(data, "config.json"),
      JSON.stringify({
        claude: {
          configDir: join(root, "claude"),
          env: { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "mock-key-not-real" },
        },
      }),
    );
    const built = await Bun.build({
      entrypoints: [join(appDir, "test/integration/smoke-main.ts")],
      target: "node",
      format: "esm",
      external: ["electron"],
    });
    expect(built.success).toBe(true);
    const script = join(root, "smoke-main.mjs");
    await Bun.write(script, (await built.outputs[0]?.text()) ?? "");

    const proc = Bun.spawn(
      [
        xvfb as string,
        "-a",
        electron as string,
        // The test machine has no setuid chrome-sandbox. The window itself is still sandboxed
        // (sandbox: true); only the process-level helper is skipped. The app never ships this flag.
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${join(root, "electron")}`,
        script,
      ],
      {
        // Everything the app and the daemon may see: nothing of this machine's environment.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          ELECTRON_ENABLE_LOGGING: "0",
          SMOKE_RENDERER: join(dist, "renderer"),
          SMOKE_PRELOAD: join(dist, "preload.cjs"),
          SMOKE_DAEMON: daemonMain,
          SMOKE_DATA: data,
          SMOKE_SOCKET: join(root, "d.sock"),
          SMOKE_HOME: home,
          SMOKE_CWD: cwd,
          ...(process.env.SMOKE_LOG ? { SMOKE_LOG: process.env.SMOKE_LOG } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let lines: Record<string, unknown>[] = [];
    try {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      lines = out
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l));
      if (proc.exitCode !== 0) console.log("electron stderr:", err.slice(-2000));
      for (const line of lines) console.log("step", JSON.stringify(line).slice(0, 1500));
      const step = (name: string) => lines.find((l) => l.step === name);
      expect(step("failed")).toBeUndefined();
      expect(proc.exitCode).toBe(0);

      // The page is locked down.
      const page = step("page")?.security as Record<string, unknown>;
      expect(page.csp).toContain("default-src 'none'");
      expect(page.csp).toContain("connect-src 'none'");
      expect(page.nodeRequire).toBe("undefined");
      expect(page.nodeProcess).toBe("undefined");
      expect(page.ipcRenderer).toBe("undefined");
      expect(page.bridgeKeys).toEqual(
        [
          "agentDefaults",
          "agents",
          "answerPermission",
          "archiveSession",
          "cancel",
          "chooseDirectory",
          "connect",
          "createSession",
          "deleteSession",
          "disconnect",
          "hosts",
          "onEvent",
          "openSession",
          "prompt",
          "removeHost",
          "renameSession",
          "saveHost",
          "sessions",
          "setAgentDefaults",
          "setSessionConfig",
        ].sort(),
      );

      expect(String(step("answer")?.text)).toContain("Hello from the mock");
      expect(String(step("permission")?.text)).toContain("touch made-by-the-agent.txt");
      expect(String(step("allowed")?.text)).toContain("All done");
      expect(step("reloaded")?.ok).toBe(true);
      // Allowing it really ran it.
      expect(existsSync(join(cwd, "made-by-the-agent.txt"))).toBe(true);
      expect(existsSync(join(home, "shot.png"))).toBe(true);
    } finally {
      const pid = Number((await readFile(join(data, "daemon.pid"), "utf8").catch(() => "")).trim());
      if (pid > 0) process.kill(pid, "SIGTERM");
      mock.stop();
    }
  },
  240_000,
);
