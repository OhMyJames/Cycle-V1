import { afterEach, beforeEach, expect, test } from "bun:test";
import { methods } from "@cycle/acp";
import { CycleErrorCode } from "@cycle/protocol";
import { Daemon } from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
let open: Daemon[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  await dispose();
});

const start = async (fake = fakeAgent()) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  return { daemon, fake };
};

const stateOf = (row: { _meta?: unknown } | undefined): unknown =>
  ((row?._meta ?? {}) as Record<string, unknown>)["cycle/state"];

const text = (value: string) => [{ type: "text" as const, text: value }];

test("creates a session, runs a prompt, and the client sees the history with seq", async () => {
  const { daemon, fake } = await start();
  const c = await connectClient(daemon);
  const created = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, {
    sessionId: created.sessionId,
    cwd: "/tmp",
  });
  const answer = await c.agent.request(methods.agent.session.prompt, {
    sessionId: created.sessionId,
    prompt: text("hi"),
  });
  expect(answer.messageId).toBeString();
  await until(() => c.idle() >= 2, "the turn to end");
  expect(c.kinds()).toEqual([
    "state_update", // the snapshot on resume
    "user_message",
    "state_update",
    "agent_message_chunk",
    "state_update",
  ]);
  // Records the daemon logged carry seq, in order; the snapshot is not a record and carries none.
  expect(c.seen.map((s) => s.seq)).toEqual([undefined, 2, 3, 4, 5]);
  // The agent was given the daemon's id, and took it.
  expect(fake.log.news[0]?._meta).toMatchObject({ "cycle/sessionId": created.sessionId });
  expect(fake.log.prompts).toEqual(["hi"]);
});

test("a working directory that does not exist on the daemon's machine is refused up front, and nothing is stored", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  await expect(c.agent.request(methods.agent.session.new, { cwd: "/no/such/dir" })).rejects.toThrow(
    /does not exist on the machine the daemon runs on/,
  );
  expect((await c.agent.request(methods.agent.session.list, {})).sessions).toHaveLength(0);
});

test("a second client replays the whole history, then goes live", async () => {
  const { daemon } = await start();
  const first = await connectClient(daemon);
  const { sessionId } = await first.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await first.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await first.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("one") });
  await until(() => first.idle() >= 2, "the first turn");

  const late = await connectClient(daemon);
  await late.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  // History in order, then replay_complete, then the state snapshot.
  expect(late.kinds()).toEqual([
    "user_message",
    "state_update",
    "agent_message_chunk",
    "state_update",
    "replay_complete",
    "state_update",
  ]);
  expect(late.seen.map((s) => s.seq).slice(0, 4)).toEqual([2, 3, 4, 5]);
  expect(late.seen[4]?.seq).toBe(5);

  const before = late.seen.length;
  await first.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("two") });
  await until(() => late.seen.length >= before + 4, "live updates");
  expect(late.seen.slice(before).map((s) => s.seq)).toEqual([6, 7, 8, 9]);
});

test("a reconnecting client asks for what it missed and gets only that", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("one") });
  await until(() => c.idle() >= 2, "the turn");
  const lastSeen = Math.max(...c.seen.map((s) => s.seq ?? 0));
  c.close();
  await c.closed;

  const back = await connectClient(daemon);
  await back.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "_cycle.seq", after: lastSeen - 2 },
  });
  expect(back.seen.filter((s) => s.seq !== undefined).map((s) => s.seq)).toEqual([
    lastSeen - 1,
    lastSeen,
    lastSeen,
  ]);
  expect(back.kinds().slice(-2)).toEqual(["replay_complete", "state_update"]);
});

test("a point past the end of the history is refused", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await expect(
    c.agent.request(methods.agent.session.resume, {
      sessionId,
      cwd: "/tmp",
      replayFrom: { type: "_cycle.seq", after: 999 },
    }),
  ).rejects.toMatchObject({ code: -32602 });
});

test("a prompt while the session is working is refused", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { daemon } = await start(fakeAgent({ onPrompt: () => gate }));
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("slow") });
  await expect(
    c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") }),
  ).rejects.toMatchObject({ code: CycleErrorCode.SessionBusy });
  release();
  await until(() => c.idle() >= 1, "the turn to end");
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("now") });
});

test("a permission request goes to every attached client; the first answer wins", async () => {
  const outcomes: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const a = await connectClient(daemon, { onPermission: () => "allow" });
  const b = await connectClient(daemon, { onPermission: () => "never" });
  const { sessionId } = await a.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await a.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await b.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await b.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
  expect(a.permissions).toHaveLength(1);
  expect(b.permissions).toHaveLength(1);
  // The client that did not answer is told it has been dealt with.
  await until(() => b.resolved.length === 1, "request_resolved");
  expect(b.resolved[0]).toMatchObject({ sessionId });
  expect(a.resolved).toHaveLength(0);
});

test("a request made while no one is attached waits for the next client", async () => {
  const outcomes: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const first = await connectClient(daemon);
  const { sessionId } = await first.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await first.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await Bun.sleep(30);
  expect(outcomes).toHaveLength(0);
  expect(first.permissions).toHaveLength(0);

  const second = await connectClient(daemon, { onPermission: () => "deny" });
  await second.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(second.permissions).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "selected", optionId: "deny" } });
});

test("a cancel answers pending requests as cancelled and reaches the agent", async () => {
  const outcomes: unknown[] = [];
  const { daemon, fake } = await start(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const c = await connectClient(daemon, { onPermission: () => "never" });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => c.permissions.length === 1, "the request");
  await c.agent.notify(methods.agent.session.cancel, { sessionId });
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "cancelled" } });
  expect(fake.log.cancels).toBe(1);
});

test("an agent that exits stops the session, ends the turn, and the next prompt resumes it", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeAgent({ onPrompt: () => gate });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hang") });
  await until(() => c.kinds().includes("user_message"), "the turn to start");
  fake.crash();
  await until(
    () => c.seen.some((s) => (s.update as { stopReason?: string }).stopReason === "error"),
    "the error",
  );
  const last = c.seen.at(-1)?.update as {
    state?: string;
    stopReason?: string;
    error?: { code: number };
  };
  expect(last).toMatchObject({
    state: "idle",
    stopReason: "error",
    error: { code: CycleErrorCode.AgentExited },
  });

  const listed = await c.agent.request(methods.agent.session.list, {});
  expect(stateOf(listed.sessions[0])).toBe("stopped");

  release();
  const ended = c.ended();
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => c.ended() > ended, "the second turn");
  // The state the agent sent when it resumed is a handshake: it is not in the history.
  const history = await c.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  void history;
  const idlesWithoutReason = c.seen.filter((s) => {
    const u = s.update as { state?: string; stopReason?: string; sessionUpdate: string };
    return s.seq !== undefined && u.state === "idle" && u.stopReason === undefined;
  });
  expect(idlesWithoutReason).toEqual([]);
  expect(fake.log.launches).toBe(2);
  // It was resumed under the agent's own id, with the directory it was created in.
  expect(fake.log.resumes.at(-1)).toMatchObject({ sessionId, cwd: "/tmp" });
});

test("sessions and their history survive a new daemon on the same data", async () => {
  const first = await start();
  const c = await connectClient(first.daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("remember") });
  await until(() => c.idle() >= 2, "the turn");
  await first.daemon.close();
  open = [];

  const second = await start();
  const d = await connectClient(second.daemon);
  const listed = await d.agent.request(methods.agent.session.list, {});
  expect(listed.sessions.map((s) => s.sessionId)).toEqual([sessionId]);
  expect(stateOf(listed.sessions[0])).toBe("stopped");
  await d.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  const userMessages = d.seen.filter((s) => s.update.sessionUpdate === "user_message");
  expect(userMessages).toHaveLength(1);
  // No agent was started just to read history.
  expect(second.fake.log.launches).toBe(0);
});

test("lists only Cycle's sessions, and renames, archives and deletes", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request("_cycle/session/set_title", { sessionId, title: "My session" });
  await c.agent.request("_cycle/session/archive", { sessionId });
  let listed = await c.agent.request(methods.agent.session.list, {});
  expect(listed.sessions[0]?._meta).toMatchObject({
    title: "My session",
    "cycle/archived": true,
    "cycle/agent": "fake",
  });
  await c.agent.request("_cycle/session/unarchive", { sessionId });
  await c.agent.request(methods.agent.session.delete, { sessionId });
  listed = await c.agent.request(methods.agent.session.list, {});
  expect(listed.sessions).toEqual([]);
  await expect(
    c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" }),
  ).rejects.toMatchObject({ code: -32002 });
  expect(c.listChanged()).toBeGreaterThan(0);
});

test("refuses a different major protocol version", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  await expect(
    c.agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "x", version: "0" },
      _meta: { "cycle/protocolVersion": "9.0" },
    } as never),
  ).rejects.toMatchObject({ code: -32022 });
});

test("an agent's defaults are kept, applied to new sessions, and overridden by what the session asks for", async () => {
  const fake = fakeAgent();
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  expect(await c.agent.request("_cycle/agent_defaults/read", { agent: "fake" })).toEqual({
    config: {},
  });
  await c.agent.request("_cycle/agent_defaults/set", { agent: "fake", config: { mode: "plan" } });
  await until(() => c.defaultsChanged() === 1, "the change to be announced");
  expect(await c.agent.request("_cycle/agent_defaults/read", { agent: "fake" })).toEqual({
    config: { mode: "plan" },
  });

  await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  expect(fake.log.configs.map((x) => [x.configId, x.value])).toEqual([["mode", "plan"]]);
  await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    _meta: { "cycle/config": { mode: "acceptEdits" } },
  });
  expect(fake.log.configs.map((x) => [x.configId, x.value]).at(-1)).toEqual([
    "mode",
    "acceptEdits",
  ]);
});

test("a default for a setting the agent does not have is refused, and defaults survive a restart", async () => {
  const first = await start();
  const c = await connectClient(first.daemon);
  await expect(
    c.agent.request("_cycle/agent_defaults/set", { agent: "fake", config: { nope: "x" } }),
  ).rejects.toMatchObject({ code: CycleErrorCode.InvalidConfig });
  await c.agent.request("_cycle/agent_defaults/set", { agent: "fake", config: { mode: "plan" } });
  await first.daemon.close();
  open = [];
  const second = await start();
  const d = await connectClient(second.daemon);
  expect(await d.agent.request("_cycle/agent_defaults/read", { agent: "fake" })).toEqual({
    config: { mode: "plan" },
  });
  await expect(
    d.agent.request("_cycle/agent_defaults/read", { agent: "nobody" }),
  ).rejects.toMatchObject({
    code: CycleErrorCode.AgentUnavailable,
  });
});

test("a session's own settings are in the list, and a change is announced", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    _meta: { "cycle/config": { mode: "plan" } },
  });
  const before = c.listChanged();
  await c.agent.request(methods.agent.session.setConfigOption, {
    sessionId,
    configId: "mode",
    type: "id",
    value: "acceptEdits",
  } as never);
  await until(() => c.listChanged() > before, "the change to be announced");
  const listed = await c.agent.request(methods.agent.session.list, {});
  expect(((listed.sessions[0]?._meta ?? {}) as Record<string, unknown>)["cycle/config"]).toEqual({
    mode: "acceptEdits",
  });
});
