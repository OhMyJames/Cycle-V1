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
import { canLaunch, launch } from "./launch.ts";

const daemonMain = join(new URL("../..", import.meta.url).pathname, "../daemon/src/main.ts");
const ready = canLaunch;

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
    try {
      const { exitCode, step } = await launch({
        root,
        data,
        home,
        cwd,
        daemon: ["bun", daemonMain],
        deadline: 110_000,
      });
      expect(step("failed")).toBeUndefined();
      expect(exitCode).toBe(0);

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
          "checkForUpdate",
          "chooseDirectory",
          "connect",
          "createSession",
          "deleteSession",
          "dequeue",
          "disconnect",
          "environments",
          "installUpdate",
          "markRead",
          "onEvent",
          "openSession",
          "prompt",
          "removeEnvironment",
          "renameSession",
          "saveEnvironment",
          "searchFiles",
          "sessions",
          "setAgentDefaults",
          "setSessionConfig",
          "updateState",
        ].sort(),
      );

      // The box showed Markdown as it was typed, with the characters of a file name left alone.
      expect(String(step("markdown-typed")?.shown)).toBe("a bold word, my_file.py and code");
      expect(step("markdown-typed")?.underscoreKept).toBe(true);
      expect(String(step("pasted")?.shown)).toContain("pasted **x** my_file.py");
      expect(String(step("answer")?.text)).toContain("Hello from the mock");
      expect(String(step("permission")?.text)).toContain("touch made-by-the-agent.txt");
      expect(String(step("allowed")?.text)).toContain("All done");
      expect(step("reloaded")?.ok).toBe(true);
      // Allowing it really ran it.
      expect(existsSync(join(cwd, "made-by-the-agent.txt"))).toBe(true);
      expect(existsSync(join(home, "shot.png"))).toBe(true);
    } finally {
      const pid = Number((await readFile(join(data, "daemon.pid"), "utf8").catch(() => "")).trim());
      // It may be gone already, and a failure above must not be hidden behind this.
      if (pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      mock.stop();
    }
  },
  120_000,
);
