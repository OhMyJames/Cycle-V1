// Spike: does the Agent SDK's query() run under Bun on this machine, against a mock API?
// Not a *.test.ts, so `bun test` and the pre-commit gate do not run it. Run it with
// `bun run test:integration` in this package.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { startMock } from "./mock-anthropic.ts";

const mock = startMock();
const config = await mkdtemp(join(tmpdir(), "cycle-v1-claude-config-"));
const cwd = await mkdtemp(join(tmpdir(), "cycle-v1-claude-cwd-"));
const started = Date.now();
try {
  const q = query({
    prompt: "Say hello.",
    options: {
      cwd,
      // An explicit environment: nothing is inherited from this process.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: config,
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: "mock-key-not-real",
      },
      permissionMode: "default",
    },
  });
  for await (const message of q) {
    console.log(message.type, JSON.stringify(message).slice(0, 300));
  }
  console.log(
    "done in",
    Date.now() - started,
    "ms; requests:",
    mock.requests.map((r) => r.method + " " + r.path),
  );
} catch (error) {
  console.log(
    "FAILED:",
    error,
    "requests:",
    mock.requests.map((r) => r.method + " " + r.path),
  );
} finally {
  mock.stop();
  await rm(config, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
}
