import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { pathsFor } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { fileLogger, formatLine, tailLines } from "../src/logger.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  await dispose();
});

const at = new Date("2026-11-20T08:00:00.000Z");

test("a line is the time, the level, the event and its fields, on one line", () => {
  expect(formatLine(at, "info", "turn_ended", { session: "s1", stopReason: "end_turn" })).toBe(
    "2026-11-20T08:00:00.000Z INFO  turn_ended session=s1 stopReason=end_turn\n",
  );
  // A value with spaces is quoted, one with lines stays on this line, and what is not given is left out.
  expect(
    formatLine(at, "warn", "prompt_failed", { error: "it broke\nhere", code: undefined, n: 3 }),
  ).toBe('2026-11-20T08:00:00.000Z WARN  prompt_failed error="it broke\\nhere" n=3\n');
});

test("a credential in a value is filtered, and a long value is cut short", () => {
  const line = formatLine(at, "warn", "agent_stderr", {
    line: "auth failed with ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
  });
  expect(line).not.toContain("sk-ant-api03");
  expect(line).toContain("[redacted]");
  const long = formatLine(at, "warn", "agent_stderr", { line: "x".repeat(5_000) });
  expect(long.length).toBeLessThan(700);
  expect(long).toContain("(5000 chars)");
});

test("the log is the owner's alone, also when the file was there before with wider permissions", () => {
  const path = join(dir, "logs", "daemon.log");
  const log = fileLogger({ path, level: "info", maxBytes: 100_000, files: 2 });
  log.info("listening");
  log.close();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "logs")).mode & 0o777).toBe(0o700);

  const older = join(dir, "old.log");
  writeFileSync(older, "", { mode: 0o644 });
  const again = fileLogger({ path: older, level: "info", maxBytes: 100_000, files: 2 });
  again.info("listening");
  again.close();
  expect(statSync(older).mode & 0o777).toBe(0o600);
});

test("below the level nothing is written", async () => {
  const path = join(dir, "daemon.log");
  const log = fileLogger({ path, level: "warn", maxBytes: 100_000, files: 2 });
  log.debug("session_loaded");
  log.info("client_connected");
  log.warn("prompt_failed");
  log.error("history_write_failed");
  log.close();
  const text = await readFile(path, "utf8");
  expect(text).not.toContain("session_loaded");
  expect(text).not.toContain("client_connected");
  expect(text).toContain("prompt_failed");
  expect(text).toContain("history_write_failed");
});

test("the log rotates past its size, keeps as many old files as it is told, and stays under its bound", async () => {
  const path = join(dir, "daemon.log");
  const maxBytes = 2_000;
  const log = fileLogger({ path, level: "info", maxBytes, files: 2 });
  for (let i = 0; i < 500; i++) log.info("client_connected", { client: i });
  log.close();
  const names = (await readdir(dir)).sort();
  expect(names).toEqual(["daemon.log", "daemon.log.1", "daemon.log.2"]);
  let total = 0;
  for (const name of names) {
    const size = statSync(join(dir, name)).size;
    expect(size).toBeLessThanOrEqual(maxBytes);
    expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    total += size;
  }
  expect(total).toBeLessThanOrEqual(maxBytes * 3);
  // The newest is in the current file, and what came just before it in the first rotated one.
  expect(await readFile(path, "utf8")).toContain("client=499");
  const current = await readFile(path, "utf8");
  const first = Number(/client=(\d+)/.exec(current)?.[1]);
  expect(await readFile(`${path}.1`, "utf8")).toContain(`client=${first - 1}\n`);
});

test("a log that cannot be written does not stop the daemon", () => {
  // A file where the directory should be.
  writeFileSync(join(dir, "blocked"), "");
  expect(() =>
    fileLogger({ path: join(dir, "blocked", "daemon.log"), level: "info", maxBytes: 1, files: 0 }),
  ).toThrow();
  const path = join(dir, "daemon.log");
  const log = fileLogger({ path, level: "info", maxBytes: 100_000, files: 0 });
  log.info("listening");
  log.close();
  writeFileSync(path, "");
  expect(() => log.info("still")).not.toThrow();
});

test("the end of a log is its last lines", () => {
  expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc\n");
  expect(tailLines("a\nb", 5)).toBe("a\nb\n");
  expect(tailLines("", 5)).toBe("");
});

test("a turn is in the log as what happened, never as what was said: no prompt, no output, no credential", async () => {
  const path = join(dir, "daemon.log");
  const log = fileLogger({ path, level: "debug", maxBytes: 1_000_000, files: 1 });
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({
        sessionUpdate: "agent_message_chunk",
        messageId: "a1",
        content: { type: "text", text: "AGENT-OUTPUT-MARKER here is the answer" },
      });
      await say({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "cat .env",
        rawInput: { command: "cat .env", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      });
    },
  });
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition], log });
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "PROMPT-MARKER please read my secrets" }],
  });
  await until(
    () => existsSync(path) && readFileSync(path, "utf8").includes("turn_ended"),
    "the turn to end",
  );
  await daemon.close();
  log.close();
  const text = await readFile(path, "utf8");
  expect(text).toContain(`turn_ended session=${sessionId} stopReason=end_turn`);
  expect(text).not.toContain("PROMPT-MARKER");
  expect(text).not.toContain("AGENT-OUTPUT-MARKER");
  expect(text).not.toContain("ghp_");
  expect(text).not.toContain("cat .env");
}, 10_000);

test("a daemon that dies of an error nothing caught says why in its log, with where, and exits 1", async () => {
  const paths = pathsFor(join(dir, "data"));
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "fixtures", "crash-serve.ts"), paths.dataDir],
    {
      stdout: "ignore",
      stderr: "pipe",
      // Nothing of this process's environment is needed, and a real home is never looked at.
      env: { PATH: process.env.PATH ?? "", HOME: dir },
    },
  );
  const timer = setTimeout(() => child.kill(), 8_000);
  const code = await child.exited;
  clearTimeout(timer);
  expect(code).toBe(1);
  const text = await readFile(paths.log, "utf8");
  expect(text).toContain("INFO  daemon_starting");
  expect(text).toContain("INFO  listening");
  expect(text).toMatch(/ERROR uncaught_exception error=".*the index went away under the daemon/);
  // Where in the code: the stack, on the same line.
  expect(text).toContain("crash-serve.ts");
  expect(existsSync(join(paths.dataDir, "daemon.pid"))).toBe(true);
}, 10_000);
