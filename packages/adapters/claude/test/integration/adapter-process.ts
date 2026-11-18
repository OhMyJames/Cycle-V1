import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, ndJsonStream, type SessionUpdate } from "@cycle/acp";

const entry = new URL("../../src/main.ts", import.meta.url).pathname;

/** What a test sees of one adapter process. */
export type Run = {
  agent: Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0];
  updates: SessionUpdate[];
  permissions: unknown[];
  idle: () => Promise<SessionUpdate>;
};

export type Options = {
  mockUrl: string;
  configDir: string;
  /** How to answer a permission request. */
  onPermission?: (request: unknown) => "allow" | "deny" | "cancel";
};

/**
 * Starts the adapter as its own process, as the daemon will, with an explicit environment and
 * nothing inherited, and speaks ACP v2 to it over stdio. Resolves when `body` is done.
 */
export const withAdapter = async <T>(
  options: Options,
  body: (run: Run) => Promise<T>,
): Promise<T> => {
  const config = {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: options.configDir,
      CLAUDE_CONFIG_DIR: options.configDir,
      ANTHROPIC_BASE_URL: options.mockUrl,
      ANTHROPIC_API_KEY: "mock-key-not-real",
    },
  };
  const proc = Bun.spawn(["bun", entry], {
    env: { PATH: process.env.PATH ?? "", CYCLE_ADAPTER_CONFIG: JSON.stringify(config) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const input = new WritableStream<Uint8Array>({
    write: (chunk) => {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close: () => {
      proc.stdin.end();
    },
  });
  const updates: SessionUpdate[] = [];
  const permissions: unknown[] = [];
  const waiting: ((u: SessionUpdate) => void)[] = [];
  const app = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      const update = params.update as { sessionUpdate: string; state?: string };
      if (update.sessionUpdate === "state_update" && update.state === "idle") {
        for (const resolve of waiting.splice(0)) resolve(params.update);
      }
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params);
      const answer = options.onPermission?.(params) ?? "allow";
      return answer === "cancel"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: answer } };
    });
  try {
    return await app.connectWith(ndJsonStream(input, proc.stdout), async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "integration-test", version: "0" },
      } as never);
      return body({
        agent,
        updates,
        permissions,
        idle: () => new Promise((resolve) => waiting.push(resolve)),
      });
    });
  } finally {
    proc.kill();
  }
};

export const tempConfigDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-v1-claude-config-"));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
};
