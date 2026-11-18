// The whole backend, as a user would run it: a client reaches the daemon over ssh (a stand-in for
// ssh, which runs the command here), `cycle proxy` starts the daemon, the daemon starts the
// Claude adapter, which runs the real Agent SDK against a mock of the Anthropic API.
// Run with `bun run test:integration` in apps/daemon. The pre-commit gate does not run it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionUpdate } from "@cycle/acp";
import { CycleClient } from "@cycle/client";
import { sshChannel } from "@cycle/transport/client";
import { isListening } from "@cycle/transport/server";
import {
  startMock,
  textReply,
} from "../../../../packages/adapters/claude/test/integration/mock-anthropic.ts";
import { fakeSsh } from "../../../../packages/transport/test/support.ts";

// CYCLE_DAEMON_BIN: run the built single-file executable instead of the source (see `bun run build`).
const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;
const DAEMON =
  process.env.CYCLE_DAEMON_BIN !== undefined ? [process.env.CYCLE_DAEMON_BIN] : ["bun", MAIN];
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-full-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const until = async (condition: () => boolean, what: string, ms = 60_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

const daemonPid = async (dataDir: string): Promise<number | undefined> => {
  const pid = await Bun.file(join(dataDir, "daemon.pid"))
    .text()
    .catch(() => "");
  return pid === "" ? undefined : Number(pid.trim());
};

test("the backend end to end: ssh, proxy, daemon, adapter, SDK, and a drop that changes nothing", async () => {
  const mock = startMock(() => textReply("Hello from the whole backend."));
  const dataDir = join(root, "data");
  const socket = join(root, "d.sock");
  const cwd = join(root, "work");
  await Bun.write(join(cwd, ".keep"), "");
  await Bun.write(
    join(dataDir, "config.json"),
    JSON.stringify({
      claude: {
        configDir: join(root, "claude"),
        env: { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "mock-key-not-real" },
      },
    }),
  );
  const ssh = await fakeSsh(root);
  // The daemon's own environment holds a key that would bill an account. It must stay there.
  process.env.ANTHROPIC_API_KEY = "SHOULD-NEVER-REACH-CLAUDE";
  let pid: number | undefined;
  try {
    const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
    const states: string[] = [];
    const client = new CycleClient({
      connect: async () =>
        sshChannel({
          host: "me@box",
          ssh: ssh.path,
          command: [...DAEMON, "proxy", "--data-dir", dataDir, "--socket", socket],
        }),
      events: {
        update: (_id, update, seq) => seen.push({ update, seq }),
        connection: (state) => states.push(state),
      },
      backoff: { first: 50, max: 500 },
    });
    // No daemon is running yet: the proxy starts one.
    expect(await isListening(socket)).toBe(false);
    await client.start();
    expect(await isListening(socket)).toBe(true);
    pid = await daemonPid(dataDir);
    expect(pid).toBeNumber();

    const agents = await client.agents();
    expect(agents.agents).toMatchObject([{ id: "claude", available: true }]);

    const sessionId = await client.newSession({ cwd, config: { mode: "default" } });
    await client.watch(sessionId, cwd);
    await client.prompt(sessionId, [{ type: "text", text: "Say hello." }]);
    const ended = (n: number) =>
      seen.filter((s) => {
        const u = s.update as { state?: string; stopReason?: string };
        return u.state === "idle" && u.stopReason !== undefined;
      }).length >= n;
    await until(() => ended(1), "the first turn");
    const streamed = () =>
      seen
        .filter((s) => s.update.sessionUpdate === "agent_message_chunk")
        .map((s) => (s.update as unknown as { content: { text: string } }).content.text)
        .join("");
    expect(streamed()).toBe("Hello from the whole backend.");

    // The ssh connection dies. The daemon, which was started detached, goes on.
    // (Cutting the client's channel stands in for the network.)
    await client.close();
    expect(await isListening(socket)).toBe(true);
    expect(await daemonPid(dataDir)).toBe(pid);

    // A new client, a new ssh, the same daemon: it asks for the history and gets it, then goes on.
    const again: { update: SessionUpdate; seq: number | undefined }[] = [];
    const second = new CycleClient({
      connect: async () =>
        sshChannel({
          host: "me@box",
          ssh: ssh.path,
          command: [...DAEMON, "proxy", "--data-dir", dataDir, "--socket", socket],
        }),
      events: { update: (_id, update, seq) => again.push({ update, seq }) },
    });
    await second.start();
    expect((await second.listSessions()).map((s) => s.sessionId)).toEqual([sessionId]);
    await second.watch(sessionId, cwd);
    expect(
      again
        .filter((s) => s.update.sessionUpdate === "agent_message_chunk")
        .map((s) => (s.update as unknown as { content: { text: string } }).content.text)
        .join(""),
    ).toBe("Hello from the whole backend.");
    await second.prompt(sessionId, [{ type: "text", text: "And once more." }]);
    await until(
      () =>
        again.filter((s) => (s.update as { stopReason?: string }).stopReason === "end_turn")
          .length >= 2,
      "the second turn",
    );
    await second.close();

    // Claude got what it was given, and nothing else: not the daemon's key.
    const asked = mock.requests.filter((r) => r.path === "/v1/messages");
    expect(asked.length).toBeGreaterThan(0);
    for (const request of mock.requests) {
      expect(JSON.stringify(request.headers)).not.toContain("SHOULD-NEVER-REACH-CLAUDE");
    }
    expect(asked.some((r) => r.headers["x-api-key"] === "mock-key-not-real")).toBe(true);
    // The second turn had the first in its context.
    expect(
      asked.some((r) => {
        const body = JSON.stringify(r.body);
        return body.includes("Say hello.") && body.includes("And once more.");
      }),
    ).toBe(true);
  } finally {
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    const toStop = pid ?? (await daemonPid(dataDir));
    if (toStop !== undefined) process.kill(toStop, "SIGTERM");
    mock.stop();
  }
}, 100_000);
