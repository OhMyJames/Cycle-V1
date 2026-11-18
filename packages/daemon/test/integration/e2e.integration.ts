// The whole path: a client, the daemon, the Claude adapter as a process, the real Agent SDK and
// its bundled Claude binary, and a local mock of the Anthropic API. No account, no network.
// Run with `bun run test:integration` in this package. The pre-commit gate does not run it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@cycle/acp";
import {
  heldTextReply,
  startMock,
  textReply,
} from "../../../adapters/claude/test/integration/mock-anthropic.ts";
import { Daemon, processAgent } from "../../src/index.ts";
import { connectClient, until } from "../client.ts";

const adapter = new URL("../../../adapters/claude/src/main.ts", import.meta.url).pathname;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cycle-v1-e2e-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

const claude = (mockUrl: string, configDir: string) =>
  processAgent({
    id: "claude",
    name: "Claude",
    command: ["bun", adapter],
    env: {
      PATH: process.env.PATH ?? "",
      CYCLE_ADAPTER_CONFIG: JSON.stringify({
        env: {
          PATH: process.env.PATH ?? "",
          HOME: configDir,
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_BASE_URL: mockUrl,
          ANTHROPIC_API_KEY: "mock-key-not-real",
        },
      }),
    },
  });

const text = (value: string) => [{ type: "text" as const, text: value }];

test("a client drives Claude through the daemon, reconnects, and the daemon restarts", async () => {
  const mock = startMock(() => textReply("Hello through the daemon."));
  const data = join(root, "data-1");
  const cwd = join(root, "work-1");
  await Bun.write(join(cwd, ".keep"), "");
  const open: Daemon[] = [];
  try {
    const daemon = await Daemon.start({
      dataDir: data,
      agents: [claude(mock.url, join(root, "claude-1"))],
    });
    open.push(daemon);
    const c = await connectClient(daemon);
    const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd });
    await c.agent.request(methods.agent.session.resume, { sessionId, cwd });
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("Say hello.") });
    await until(() => c.ended() >= 1, "the turn to end", 60_000);
    const streamed = c.seen
      .filter((s) => s.update.sessionUpdate === "agent_message_chunk")
      .map((s) => (s.update as unknown as { content: { text: string } }).content.text)
      .join("");
    expect(streamed).toBe("Hello through the daemon.");
    console.log("client saw:", c.kinds().join(", "), "| seqs:", c.seen.map((s) => s.seq).join(","));

    // The client drops. A new one asks for what it missed.
    const lastSeen = Math.max(...c.seen.map((s) => s.seq ?? 0));
    c.close();
    await c.closed;
    const back = await connectClient(daemon);
    await back.agent.request(methods.agent.session.resume, {
      sessionId,
      cwd,
      replayFrom: { type: "_cycle.seq", after: lastSeen - 1 },
    });
    expect(back.seen.filter((s) => s.seq !== undefined).map((s) => s.seq)).toEqual([
      lastSeen,
      lastSeen,
    ]);

    // The daemon restarts; the agent process is gone; history is on disk.
    await daemon.close();
    open.length = 0;
    const again = await Daemon.start({
      dataDir: data,
      agents: [claude(mock.url, join(root, "claude-1"))],
    });
    open.push(again);
    const d = await connectClient(again);
    await d.agent.request(methods.agent.session.resume, {
      sessionId,
      cwd,
      replayFrom: { type: "start" },
    });
    const replayed = d.seen
      .filter((s) => s.update.sessionUpdate === "agent_message_chunk")
      .map((s) => (s.update as unknown as { content: { text: string } }).content.text)
      .join("");
    expect(replayed).toBe("Hello through the daemon.");

    // And the conversation goes on: the daemon starts Claude again and resumes the session.
    const ended = d.ended();
    await d.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("And again.") });
    await until(() => d.ended() > ended, "the turn after the restart", 60_000);
    const lastIdle = d.seen.filter((s) => (s.update as { state?: string }).state === "idle").at(-1);
    console.log("turn after restart ended:", JSON.stringify(lastIdle?.update));
    expect(lastIdle?.update).toMatchObject({ stopReason: "end_turn" });
    // Claude also sends requests of its own; the one for this turn has both prompts in it.
    const bodies = mock.requests
      .filter((r) => r.path === "/v1/messages")
      .map((r) => JSON.stringify(r.body));
    expect(bodies.some((b) => b.includes("And again.") && b.includes("Say hello."))).toBe(true);
  } finally {
    for (const daemon of open) await daemon.close();
    mock.stop();
  }
}, 180_000);

test("cancel through the daemon, while Claude is still writing", async () => {
  const held = heldTextReply("The first part. ", "THE REST THAT MUST NOT ARRIVE.");
  let heldGiven = false;
  const mock = startMock(() => {
    if (heldGiven) return textReply("A reply to a request of Claude's own.");
    heldGiven = true;
    return held.body;
  });
  const data = join(root, "data-2");
  const cwd = join(root, "work-2");
  await Bun.write(join(cwd, ".keep"), "");
  const daemon = await Daemon.start({
    dataDir: data,
    agents: [claude(mock.url, join(root, "claude-2"))],
  });
  try {
    const c = await connectClient(daemon);
    const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd });
    await c.agent.request(methods.agent.session.resume, { sessionId, cwd });
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("Go.") });
    await until(() => c.kinds().includes("agent_message_chunk"), "the first words", 60_000);
    await c.agent.notify(methods.agent.session.cancel, { sessionId });
    await until(
      () => c.seen.some((s) => (s.update as { stopReason?: string }).stopReason === "cancelled"),
      "cancelled",
      10_000,
    );
    held.release();
    await Bun.sleep(1_000);
    const text2 = c.seen
      .filter((s) => s.update.sessionUpdate === "agent_message_chunk")
      .map((s) => (s.update as unknown as { content: { text: string } }).content.text)
      .join("");
    expect(text2).not.toContain("MUST NOT ARRIVE");
    // The session can be used again.
    const ended = c.ended();
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("Again.") });
    await until(() => c.ended() > ended, "a turn after the cancel", 60_000).catch(() => undefined);
  } finally {
    held.release();
    await daemon.close();
    mock.stop();
  }
}, 180_000);
