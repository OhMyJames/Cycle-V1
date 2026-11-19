import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@cycle/acp";
import { CycleErrorCode } from "@cycle/protocol";
import { Daemon, JsonlLogStore, type LogStore, type SessionLog } from "../src/index.ts";
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

/** What a client that asks for it is listed: only the sessions something has been said in (docs/protocol.md §6). */
const SAID = { _meta: { "cycle/onlyPrompted": true } } as never;

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
  // Nothing said in it yet: it is not in the list (docs/protocol.md §6).
  let listed = await c.agent.request(methods.agent.session.list, SAID);
  expect(listed.sessions).toEqual([]);
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the turn to end");
  await c.agent.request("_cycle/session/set_title", { sessionId, title: "My session" });
  await c.agent.request("_cycle/session/archive", { sessionId });
  listed = await c.agent.request(methods.agent.session.list, {});
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

test("a session is in the list from the person's first message, and is announced then; before that it is still there to open", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  // A blank conversation that has become a session, with nothing said yet: not listed, but it can be opened.
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  expect((await c.agent.request(methods.agent.session.list, SAID)).sessions).toEqual([]);
  // A client that does not ask (an older one, which opens what it made by finding it in the list) still sees it.
  expect(
    (await c.agent.request(methods.agent.session.list, {})).sessions.map((s) => s.sessionId),
  ).toEqual([sessionId]);
  const before = c.listChanged();
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.listChanged() > before, "the first message to be announced");
  await until(() => c.ended() >= 1, "the turn to end");
  const listed = await c.agent.request(methods.agent.session.list, SAID);
  expect(listed.sessions.map((s) => s.sessionId)).toEqual([sessionId]);
  // Kept across a restart, from the index.
  await daemon.close();
  open = [];
  const again = await start();
  const d = await connectClient(again.daemon);
  expect(
    (await d.agent.request(methods.agent.session.list, SAID)).sessions.map((s) => s.sessionId),
  ).toEqual([sessionId]);
});

test("a first message the daemon takes puts the session in the list, even if the agent never gets it", async () => {
  const fake = fakeAgent();
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const sessionId = await startedSession(c);
  const announced = c.listChanged();
  fake.crash();
  fake.control.failLaunch = true;
  await until(() => c.listChanged() > announced, "the exit to be announced");
  await expect(
    c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") }),
  ).rejects.toBeDefined();
  // It is there to be seen and deleted, with what happened to its first message.
  expect(
    (await c.agent.request(methods.agent.session.list, SAID)).sessions.map((s) => s.sessionId),
  ).toEqual([sessionId]);
  // A prompt refused before it is taken (one the agent cannot hold) does not.
  fake.control.failLaunch = false;
  const other = await startedSession(c);
  await expect(
    c.agent.request(methods.agent.session.prompt, {
      sessionId: other,
      prompt: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] as never,
    }),
  ).rejects.toMatchObject({ code: -32602 });
  expect(
    (await c.agent.request(methods.agent.session.list, SAID)).sessions.map((s) => s.sessionId),
  ).toEqual([sessionId]);
});

test("an index written before it said whether anything was said is read from the logs, once", async () => {
  const first = await start();
  const c = await connectClient(first.daemon);
  const spoken = (await c.agent.request(methods.agent.session.new, { cwd: "/tmp" })).sessionId;
  const silent = (await c.agent.request(methods.agent.session.new, { cwd: "/tmp" })).sessionId;
  await c.agent.request(methods.agent.session.resume, { sessionId: spoken, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId: spoken, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the turn to end");
  await first.daemon.close();
  open = [];
  // As an older daemon wrote it: no `prompted` on any entry.
  const path = join(dir, "index.json");
  const index = JSON.parse(await readFile(path, "utf8")) as {
    sessions: Record<string, Record<string, unknown>>;
  };
  for (const entry of Object.values(index.sessions)) delete entry.prompted;
  await writeFile(path, JSON.stringify(index));

  const second = await start();
  const d = await connectClient(second.daemon);
  expect(
    (await d.agent.request(methods.agent.session.list, SAID)).sessions.map((s) => s.sessionId),
  ).toEqual([spoken]);
  await second.daemon.close();
  open = [];
  const kept = JSON.parse(await readFile(path, "utf8")) as {
    sessions: Record<string, { prompted?: boolean }>;
  };
  expect(kept.sessions[spoken]?.prompted).toBe(true);
  expect(kept.sessions[silent]?.prompted).toBe(false);
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

test("what a new session starts with is on record, under what it was asked for", async () => {
  // Recorded so that a resume sends it again: a later change to the agent's own default does not
  // change a session that already exists.
  const startsWith = (value: string) => ({
    configId: "mode",
    name: "Mode",
    type: "select",
    currentValue: value,
    options: [{ value, name: value }],
  });
  const fake = fakeAgent({}, { configOptions: [startsWith("auto")] });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const plain = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  const planned = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    _meta: { "cycle/config": { mode: "plan" } },
  });
  // In the list once something is said in them.
  for (const { sessionId } of [plain, planned]) {
    await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  }
  await until(() => c.ended() >= 2, "both turns to end");
  const listed = await c.agent.request(methods.agent.session.list, {});
  const configs = listed.sessions.map(
    (s) => ((s._meta ?? {}) as Record<string, unknown>)["cycle/config"],
  );
  expect(configs).toHaveLength(2);
  expect(configs).toContainEqual({ mode: "auto" });
  expect(configs).toContainEqual({ mode: "plan" });
});

test("a session's own settings are in the list, and a change is announced", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    _meta: { "cycle/config": { mode: "plan" } },
  });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the turn to end");
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

// ---- what the list says of a session: when, unread, background (docs/protocol.md §6) ----

type Row = { sessionId: string; updatedAt?: string | null; _meta?: unknown };
const rowOf = async (c: Awaited<ReturnType<typeof connectClient>>, sessionId: string) => {
  const listed = await c.agent.request(methods.agent.session.list, {});
  const row = (listed.sessions as Row[]).find((each) => each.sessionId === sessionId);
  if (row === undefined) throw new Error("the session is not listed");
  return { row, meta: (row._meta ?? {}) as Record<string, unknown> };
};
const lastSeqOf = async (c: Awaited<ReturnType<typeof connectClient>>, sessionId: string) =>
  (await rowOf(c, sessionId)).meta["cycle/lastSeq"] as number;

const startedSession = async (c: Awaited<ReturnType<typeof connectClient>>) => {
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  return sessionId;
};

test("the list says when a session last had something happen, and that is not the daemon's own notes", async () => {
  const { daemon, fake } = await start();
  const c = await connectClient(daemon);
  const made = new Date().toISOString();
  const sessionId = await startedSession(c);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the turn to end");
  const worked = (await rowOf(c, sessionId)).row.updatedAt ?? "";
  expect(Number.isNaN(Date.parse(worked))).toBe(false);
  expect(worked >= made).toBe(true);
  // The agent going away is a note of the daemon's: it moves nothing.
  const announced = c.listChanged();
  fake.crash();
  await until(() => c.listChanged() > announced, "the agent's exit to be announced");
  expect((await rowOf(c, sessionId)).row.updatedAt).toBe(worked);
});

test("a turn that ended is unread until a client says it has seen it, and that is kept across a restart", async () => {
  const first = await start();
  const c = await connectClient(first.daemon);
  const sessionId = await startedSession(c);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the turn to end");
  expect((await rowOf(c, sessionId)).meta["cycle/unread"]).toBe(true);

  const before = c.listChanged();
  const seen = await lastSeqOf(c, sessionId);
  await c.agent.request("_cycle/session/mark_read", { sessionId, seq: seen });
  expect((await rowOf(c, sessionId)).meta["cycle/unread"]).toBe(false);
  await until(() => c.listChanged() > before, "the change to be announced");

  // It never goes back: an older seq changes nothing, and a seq past the log is refused.
  await c.agent.request("_cycle/session/mark_read", { sessionId, seq: 1 });
  expect((await rowOf(c, sessionId)).meta["cycle/unread"]).toBe(false);
  await expect(
    c.agent.request("_cycle/session/mark_read", { sessionId, seq: seen + 1000 }),
  ).rejects.toMatchObject({ code: -32602 });

  // A second turn is unread again; a restart keeps both what was read and what was not.
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => c.ended() >= 2, "the second turn to end");
  expect((await rowOf(c, sessionId)).meta["cycle/unread"]).toBe(true);
  await first.daemon.close();
  open = [];
  const second = await start();
  const d = await connectClient(second.daemon);
  expect((await rowOf(d, sessionId)).meta["cycle/unread"]).toBe(true);
  await d.agent.request("_cycle/session/mark_read", {
    sessionId,
    seq: await lastSeqOf(d, sessionId),
  });
  await second.daemon.close();
  open = [];
  const third = await start();
  const e = await connectClient(third.daemon);
  expect((await rowOf(e, sessionId)).meta["cycle/unread"]).toBe(false);
});

test("two clients marking at once cannot move the mark back", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const sessionId = await startedSession(c);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the turn to end");
  const seen = await lastSeqOf(c, sessionId);
  // The higher mark first, the lower one right behind it, neither waiting for the other.
  await Promise.all([
    c.agent.request("_cycle/session/mark_read", { sessionId, seq: seen }),
    c.agent.request("_cycle/session/mark_read", { sessionId, seq: 1 }),
  ]);
  expect((await rowOf(c, sessionId)).meta["cycle/unread"]).toBe(false);
});

test("a turn the agent's exit ended is unread, and the list is announced after the mark is there", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeAgent({ onPrompt: () => gate });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const sessionId = await startedSession(c);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hang") });
  await until(() => c.kinds().includes("user_message"), "the turn to start");
  expect((await rowOf(c, sessionId)).meta["cycle/unread"]).toBe(false);
  const before = c.listChanged();
  fake.crash();
  release();
  await until(
    () => c.seen.some((s) => (s.update as { stopReason?: string }).stopReason === "error"),
    "the error",
  );
  // An announcement that comes after the record, when the row already says so.
  await until(() => c.listChanged() > before + 1, "the list to be announced after the record");
  expect((await rowOf(c, sessionId)).meta["cycle/unread"]).toBe(true);
});

test("a prompt that fails is a turn that ended in error: on record, and unread", async () => {
  const fake = fakeAgent();
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const sessionId = await startedSession(c);
  // Something said and seen, so it is in the list and nothing in it is new.
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("first") });
  await until(() => c.ended() >= 1, "the first turn to end");
  await c.agent.request("_cycle/session/mark_read", {
    sessionId,
    seq: await lastSeqOf(c, sessionId),
  });
  expect((await rowOf(c, sessionId)).meta["cycle/unread"]).toBe(false);
  // The agent is gone and cannot be started again: the prompt is refused, and that is the end of the turn.
  const announced = c.listChanged();
  fake.crash();
  fake.control.failLaunch = true;
  await until(() => c.listChanged() > announced, "the exit to be announced");
  await expect(
    c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") }),
  ).rejects.toBeDefined();
  await until(
    () => c.seen.some((s) => (s.update as { stopReason?: string }).stopReason === "error"),
    "the turn end to be on record",
  );
  const ends = c.seen.filter((s) => (s.update as { stopReason?: string }).stopReason === "error");
  expect(ends).toHaveLength(1);
  expect(ends[0]?.update).toMatchObject({
    state: "idle",
    error: { code: expect.any(Number), message: "The agent cannot start" },
  });
  expect((await rowOf(c, sessionId)).meta["cycle/unread"]).toBe(true);
});

test("a session waiting on the owner is unread and announced even if the agent says nothing of it, and answering is announced", async () => {
  // As the Claude adapter does: it asks for permission and sends no state_update of its own.
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask();
      },
    }),
  );
  const c = await connectClient(daemon, { onPermission: () => "never" });
  const sessionId = await startedSession(c);
  const before = c.listChanged();
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.permissions.length > 0, "the request");
  expect((await rowOf(c, sessionId)).meta["cycle/unread"]).toBe(true);
  expect(stateOf((await rowOf(c, sessionId)).row)).toBe("requires_action");
  await until(() => c.listChanged() > before, "the wait to be announced");

  // A second client answers it: the list is announced again, with the session no longer waiting.
  const waiting = c.listChanged();
  const d = await connectClient(daemon, { onPermission: () => "allow" });
  await d.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await until(() => d.permissions.length > 0, "the second client to be asked");
  await until(() => c.listChanged() > waiting, "the answer to be announced");
  expect(stateOf((await rowOf(c, sessionId)).row)).not.toBe("requires_action");
});

test("a long answer does not announce the list again for every piece of it", async () => {
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ say }) => {
        for (let i = 0; i < 30; i++) {
          await say({
            sessionUpdate: "agent_message_chunk",
            messageId: "a1",
            content: { type: "text", text: "x" },
          });
        }
      },
    }),
  );
  const c = await connectClient(daemon);
  const sessionId = await startedSession(c);
  await Bun.sleep(50);
  const before = c.listChanged();
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.ended() >= 1, "the turn to end");
  // Running and ended are announced: waited for. Then a moment for anything more to arrive.
  await until(() => c.listChanged() - before >= 2, "the two changes of state to be announced");
  await Bun.sleep(100);
  // And nowhere near one for each of the thirty chunks.
  expect(c.listChanged() - before).toBeLessThanOrEqual(6);
});

test("background sub-agents are counted while they run, and are gone with the agent", async () => {
  const sub = (state: object, background?: boolean, id = "task-1") => ({
    sessionUpdate: "subagent_update",
    sessionId: id,
    state,
    _meta: {
      "cycle/subagent": { toolCallId: id, ...(background === undefined ? {} : { background }) },
    },
  });
  const running = { state: "running" };
  const idle = { state: "idle", stopReason: "end_turn" };
  const { daemon, fake } = await start(
    fakeAgent({
      onPrompt: async ({ prompt, say }) => {
        if (prompt === "start") await say(sub(running, true));
        if (prompt === "foreground") await say(sub(running, false));
        // A later update that leaves the flag out keeps it as it was.
        if (prompt === "progress") await say(sub(running));
        if (prompt === "second") await say(sub(running, true, "task-2"));
        if (prompt === "end") await say(sub(idle));
        if (prompt === "end second") await say(sub(idle, undefined, "task-2"));
      },
    }),
  );
  const c = await connectClient(daemon);
  const sessionId = await startedSession(c);
  let turns = 0;
  const turn = async (word: string) => {
    turns += 1;
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(word) });
    await until(() => c.ended() >= turns, `the "${word}" turn to end`);
  };
  const background = async () => (await rowOf(c, sessionId)).meta["cycle/background"];

  await turn("foreground");
  expect(await background()).toBeUndefined();
  await turn("end");

  const before = c.listChanged();
  await turn("start");
  await turn("progress");
  // The turn is over and the session is idle, with one sub-agent still at work.
  expect(stateOf((await rowOf(c, sessionId)).row)).toBe("idle");
  expect(await background()).toBe(1);
  expect(c.listChanged()).toBeGreaterThan(before);

  // The number is announced whenever it changes, not only to and from none.
  let announced = c.listChanged();
  await turn("second");
  expect(await background()).toBe(2);
  await until(() => c.listChanged() > announced, "1 to 2 to be announced");
  announced = c.listChanged();
  await turn("end");
  expect(await background()).toBe(1);
  await until(() => c.listChanged() > announced, "2 to 1 to be announced");
  await turn("end second");
  expect(await background()).toBeUndefined();

  // The agent process going takes its sub-agents with it, and the list is told.
  await turn("start");
  expect(await background()).toBe(1);
  announced = c.listChanged();
  fake.crash();
  await until(() => c.listChanged() > announced, "the list to be announced");
  expect(await background()).toBeUndefined();
});

test("a mark the index holds past the end of the log is brought back to it", async () => {
  const first = await start();
  const c = await connectClient(first.daemon);
  const sessionId = await startedSession(c);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the turn to end");
  await first.daemon.close();
  open = [];
  // As after a crash that cost the log its tail: the index says more than the log has.
  const path = join(dir, "index.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.sessions[sessionId].readSeq = 9999;
  stored.sessions[sessionId].attentionSeq = 9999;
  await writeFile(path, JSON.stringify(stored));

  const second = await start();
  const d = await connectClient(second.daemon);
  expect((await rowOf(d, sessionId)).meta["cycle/unread"]).toBe(false);
  await d.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await d.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => d.ended() >= 1, "the next turn to end");
  // Its records number past the log's old end, and the mark does not hide them.
  expect((await rowOf(d, sessionId)).meta["cycle/unread"]).toBe(true);
});

test("the daemon says it takes mark_read, and speaks protocol 0.2", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const meta = (c.init as { _meta?: Record<string, unknown> })._meta ?? {};
  expect(meta["cycle/protocolVersion"]).toBe("0.2");
  expect((meta["cycle/capabilities"] as { sessionOps: string[] }).sessionOps).toContain("markRead");
});

/**
 * The real JSONL store, with a hand on it: it counts how often each log is opened, and can be told
 * to refuse the writes of some kinds (all kinds with "*").
 */
const flaky = () => {
  const real = new JsonlLogStore({ dir: join(dir, "sessions") });
  const state = { opens: new Map<string, number>(), failing: new Set<string>() };
  const store: LogStore = {
    exists: (id) => real.exists(id),
    remove: (id) => real.remove(id),
    open: async (id) => {
      state.opens.set(id, (state.opens.get(id) ?? 0) + 1);
      const log = await real.open(id);
      const wrapped: SessionLog = {
        sessionId: log.sessionId,
        lastSeq: () => log.lastSeq(),
        updatedAt: () => log.updatedAt(),
        read: (range) => log.read(range),
        subscribe: (listener) => log.subscribe(listener),
        close: () => log.close(),
        append: async (record) => {
          if (state.failing.has("*") || state.failing.has(record.kind))
            throw new Error("disk full");
          return log.append(record);
        },
      };
      return wrapped;
    },
  };
  return { store, state };
};

const startOn = async (store: LogStore, fake = fakeAgent()) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition], store });
  open.push(daemon);
  return { daemon, fake };
};

const afterWriteFails = async (script: Parameters<typeof fakeAgent>[0] = {}) => {
  const { store, state } = flaky();
  const { daemon, fake } = await startOn(store, fakeAgent(script));
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  return { c, daemon, fake, state, sessionId };
};

test("a turn whose history cannot be written is stopped, every client is told, and no new turn starts", async () => {
  const { c, fake, state, sessionId } = await afterWriteFails();
  const lastSeq = () => c.seen.filter((s) => s.seq !== undefined).length;
  const before = lastSeq();
  state.failing.add("*");
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the client to be told the turn stopped");
  const told = c.seen.find((s) => (s.update as { stopReason?: string }).stopReason === "error");
  // By a path that is not the log: it has no seq, and nothing after the failure was logged.
  expect(told?.seq).toBeUndefined();
  expect(told?.update).toMatchObject({
    state: "idle",
    error: { code: CycleErrorCode.LogUnavailable },
  });
  expect(lastSeq()).toBe(before);
  // The agent was told to stop; the next prompt is refused, and says why, and never reaches it.
  await until(() => fake.log.cancels >= 1, "the agent to be cancelled");
  await expect(
    c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") }),
  ).rejects.toMatchObject({ code: CycleErrorCode.LogUnavailable });
  expect(fake.log.prompts).toEqual(["hi"]);
});

test("a client that attaches after the history failed is told so in the state it opens with", async () => {
  const { c, daemon, state, sessionId } = await afterWriteFails();
  state.failing.add("*");
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the failure to be told");
  const late = await connectClient(daemon);
  await late.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  expect(late.seen.at(-1)?.update).toMatchObject({
    sessionUpdate: "state_update",
    state: "idle",
    _meta: { "cycle/historyFailed": true },
  });
  const row = (await late.agent.request(methods.agent.session.list, {})).sessions[0];
  expect(((row?._meta ?? {}) as Record<string, unknown>)["cycle/historyFailed"]).toBe(true);
});

test("a permission answer is given to the agent only once it is on record: if it cannot be written, the answer is no", async () => {
  const outcomes: unknown[] = [];
  const { store, state } = flaky();
  const { daemon } = await startOn(
    store,
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  // The request is written and shown; the disk refuses as the client's answer ("allow") goes back.
  const c = await connectClient(daemon, {
    onPermission: () => {
      state.failing.add("response");
      return "allow";
    },
  });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "cancelled" } });
});

test("a permission request that cannot be written is shown to no one, and the agent is told no", async () => {
  const outcomes: unknown[] = [];
  const { c, state, sessionId } = await afterWriteFails({
    onPrompt: async ({ ask }) => {
      outcomes.push(await ask());
    },
  });
  state.failing.add("request");
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "cancelled" } });
  expect(c.permissions).toHaveLength(0);
});

test("two clients that open the same stored session at once share one load: one log, one history for both", async () => {
  const first = flaky();
  const one = await startOn(first.store);
  const seed = await connectClient(one.daemon);
  const { sessionId } = await seed.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await seed.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await seed.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("first") });
  await until(() => seed.ended() >= 1, "the first turn");
  await one.daemon.close();
  open = [];

  const cold = flaky();
  const { daemon } = await startOn(cold.store);
  const a = await connectClient(daemon);
  const b = await connectClient(daemon);
  await Promise.all(
    [a, b].map((c) => c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" })),
  );
  await a.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("second") });
  await until(() => a.ended() >= 1 && b.ended() >= 1, "both clients to see the turn end");
  expect(cold.state.opens.get(sessionId)).toBe(1);
  const users = (c: typeof a) => c.seen.filter((s) => s.update.sessionUpdate === "user_message");
  expect(users(b)).toHaveLength(1);
  expect(users(b).map((s) => s.seq)).toEqual(users(a).map((s) => s.seq));
});

test("a session that cannot be loaded can be asked for again", async () => {
  const first = flaky();
  const one = await startOn(first.store);
  const seed = await connectClient(one.daemon);
  const { sessionId } = await seed.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await one.daemon.close();
  open = [];

  const file = join(dir, "sessions", `${sessionId}.jsonl`);
  const good = await readFile(file, "utf8");
  await writeFile(file, `${good}{not json}\n`);
  const { daemon } = await startOn(flaky().store);
  const c = await connectClient(daemon);
  await expect(
    c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" }),
  ).rejects.toMatchObject({ code: CycleErrorCode.LogUnavailable });
  await writeFile(file, good);
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
});

test("an agent that asks for permission after the history failed is not left waiting", async () => {
  const outcomes: unknown[] = [];
  const { c, state, sessionId } = await afterWriteFails({
    onPrompt: async ({ ask }) => {
      outcomes.push(await ask());
    },
  });
  state.failing.add("*");
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "cancelled" } });
  expect(c.permissions).toHaveLength(0);
});

test("once the history has failed nothing more is written, even if the disk comes back", async () => {
  const outcomes: unknown[] = [];
  let release: () => void = () => {};
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { c, state, sessionId } = await afterWriteFails({
    onPrompt: async ({ ask }) => {
      await later;
      outcomes.push(await ask());
    },
  });
  state.failing.add("*");
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => c.ended() >= 1, "the failure to be told");
  // The disk is fine again, and the agent (which has not stopped yet) asks.
  state.failing.clear();
  release();
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "cancelled" } });
  expect(c.permissions).toHaveLength(0);
});

test("deleting a session whose agent is running does not tell the others that its history failed", async () => {
  const { daemon } = await start();
  const a = await connectClient(daemon);
  const b = await connectClient(daemon);
  const { sessionId } = await a.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  for (const c of [a, b])
    await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await a.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => a.ended() >= 1 && b.ended() >= 1, "the turn to end");
  await a.agent.request(methods.agent.session.delete, { sessionId });
  await Bun.sleep(150);
  const errors = b.seen.filter((s) => (s.update as { error?: unknown }).error !== undefined);
  expect(errors).toHaveLength(0);
  expect(b.ended()).toBe(1);
});

test("the list is announced as changed when a session's history fails, even with no one attached to it", async () => {
  let release: () => void = () => {};
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { c, daemon, state, sessionId } = await afterWriteFails({
    onPrompt: async ({ say }) => {
      await later;
      await say({
        sessionUpdate: "agent_message_chunk",
        messageId: "a1",
        content: { type: "text", text: "x" },
      });
    },
  });
  const watcher = await connectClient(daemon);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await c.close();
  await Bun.sleep(100);
  const before = watcher.listChanged();
  state.failing.add("*");
  release();
  await until(() => watcher.listChanged() > before, "the list to be announced as changed");
  const row = (await watcher.agent.request(methods.agent.session.list, {})).sessions[0];
  expect(((row?._meta ?? {}) as Record<string, unknown>)["cycle/historyFailed"]).toBe(true);
});

const seedSessions = async (count: number) => {
  const first = await start();
  const c = await connectClient(first.daemon);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
    await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(`hello ${i}`) });
    ids.push(sessionId);
  }
  await until(() => c.ended() >= count, "the turns");
  await first.daemon.close();
  open = [];
  return ids;
};

test("a session whose history is damaged is listed with a marker; the others are listed and open as usual", async () => {
  const [good, bad] = (await seedSessions(2)) as [string, string];
  const file = join(dir, "sessions", `${bad}.jsonl`);
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.splice(1, 0, "{this is not json}");
  await writeFile(file, lines.join("\n"));

  const { daemon } = await start();
  const c = await connectClient(daemon);
  const listed = (await c.agent.request(methods.agent.session.list, {})).sessions;
  expect(listed.map((s) => s.sessionId).sort()).toEqual([good, bad].sort());
  const meta = (id: string | undefined) =>
    (listed.find((s) => s.sessionId === id)?._meta ?? {}) as Record<string, unknown>;
  expect(meta(bad)["cycle/historyFailed"]).toBe(true);
  expect(meta(bad)["cycle/lastSeq"]).toBeUndefined();
  expect(meta(bad)["cycle/state"]).toBe("stopped");
  expect(meta(good)["cycle/historyFailed"]).toBeUndefined();
  expect(meta(good)["cycle/lastSeq"]).toBeGreaterThan(0);
  // The damaged one says so when it is opened; the healthy one opens and works.
  await expect(
    c.agent.request(methods.agent.session.resume, { sessionId: bad, cwd: "/tmp" }),
  ).rejects.toMatchObject({ code: CycleErrorCode.LogUnavailable });
  await c.agent.request(methods.agent.session.resume, { sessionId: good, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId: good,
    prompt: text("more"),
  });
  await until(() => c.ended() >= 1, "the healthy session to take a turn");
});

test("a session whose history file is gone is listed as unreadable, and no empty file is made in its place", async () => {
  const [good, lost] = (await seedSessions(2)) as [string, string];
  const file = join(dir, "sessions", `${lost}.jsonl`);
  await rm(file);

  const { daemon } = await start();
  const c = await connectClient(daemon);
  const listed = (await c.agent.request(methods.agent.session.list, {})).sessions;
  const meta = (id: string | undefined) =>
    (listed.find((s) => s.sessionId === id)?._meta ?? {}) as Record<string, unknown>;
  expect(meta(lost)["cycle/historyFailed"]).toBe(true);
  expect(meta(good)["cycle/historyFailed"]).toBeUndefined();
  expect(existsSync(file)).toBe(false);
  await expect(
    c.agent.request(methods.agent.session.resume, { sessionId: lost, cwd: "/tmp" }),
  ).rejects.toMatchObject({ code: CycleErrorCode.LogUnavailable });
  expect(existsSync(file)).toBe(false);
  // The way out: it can still be deleted.
  await c.agent.request(methods.agent.session.delete, { sessionId: lost });
  const after = (await c.agent.request(methods.agent.session.list, {})).sessions;
  expect(after.map((s) => s.sessionId)).toEqual([good]);
});

test("a half line left by a crash is not damage: the session is listed and opens as before", async () => {
  const [id] = (await seedSessions(1)) as [string];
  await appendFile(join(dir, "sessions", `${id}.jsonl`), '{"seq": 99, "kind":"upd');
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const listed = (await c.agent.request(methods.agent.session.list, {})).sessions;
  expect(listed.map((s) => s.sessionId)).toEqual([id]);
  expect(
    ((listed[0]?._meta ?? {}) as Record<string, unknown>)["cycle/historyFailed"],
  ).toBeUndefined();
  await c.agent.request(methods.agent.session.resume, { sessionId: id, cwd: "/tmp" });
});

test("a session being deleted cannot be opened again while its log is being removed, and a list read meanwhile goes on", async () => {
  const real = new JsonlLogStore({ dir: join(dir, "sessions") });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let removing = false;
  const store: LogStore = {
    exists: (id) => real.exists(id),
    open: (id) => real.open(id),
    remove: async (id) => {
      removing = true;
      await held;
      return real.remove(id);
    },
  };
  const fake = fakeAgent();
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition], store });
  open.push(daemon);
  const c = await connectClient(daemon);
  const keep = (await c.agent.request(methods.agent.session.new, { cwd: "/tmp" })).sessionId;
  await c.agent.request(methods.agent.session.resume, { sessionId: keep, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId: keep, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the turn to end");
  const doomed = (await c.agent.request(methods.agent.session.new, { cwd: "/tmp" })).sessionId;
  const deleting = c.agent.request(methods.agent.session.delete, { sessionId: doomed });
  await until(() => removing, "the log to be on its way out");
  await expect(
    c.agent.request(methods.agent.session.resume, { sessionId: doomed, cwd: "/tmp" }),
  ).rejects.toMatchObject({ code: -32002 });
  expect(
    (await c.agent.request(methods.agent.session.list, {})).sessions.map((s) => s.sessionId),
  ).toEqual([keep]);
  release();
  await deleting;
});

test("a session whose history is damaged can be deleted", async () => {
  const [good, bad] = (await seedSessions(2)) as [string, string];
  const file = join(dir, "sessions", `${bad}.jsonl`);
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.splice(1, 0, "{this is not json}");
  await writeFile(file, lines.join("\n"));
  const { daemon } = await start();
  const c = await connectClient(daemon);
  await c.agent.request(methods.agent.session.delete, { sessionId: bad });
  const listed = (await c.agent.request(methods.agent.session.list, {})).sessions;
  expect(listed.map((s) => s.sessionId)).toEqual([good]);
  await expect(readFile(file, "utf8")).rejects.toThrow();
});

test("a list that is being read when a session is deleted leaves that session out and goes on", async () => {
  const [first, second] = (await seedSessions(2)) as [string, string];
  const real = new JsonlLogStore({ dir: join(dir, "sessions") });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = false;
  const store: LogStore = {
    exists: (id) => real.exists(id),
    remove: (id) => real.remove(id),
    open: async (id) => {
      if (id === first) {
        waiting = true;
        await gate;
      }
      return real.open(id);
    },
  };
  const { daemon } = await startOn(store);
  const c = await connectClient(daemon);
  const d = await connectClient(daemon);
  const listing = c.agent.request(methods.agent.session.list, {});
  await until(() => waiting, "the list to be reading the first session");
  await d.agent.request(methods.agent.session.delete, { sessionId: second });
  release();
  expect((await listing).sessions.map((s) => s.sessionId)).toEqual([first]);
});

test("a session that is being deleted cannot be prompted or opened", async () => {
  const real = new JsonlLogStore({ dir: join(dir, "sessions") });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let removing = false;
  const store: LogStore = {
    exists: (id) => real.exists(id),
    open: (id) => real.open(id),
    remove: async (id) => {
      removing = true;
      await held;
      return real.remove(id);
    },
  };
  const { daemon, fake } = await startOn(store);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  const launches = fake.log.launches;
  const deleting = c.agent.request(methods.agent.session.delete, { sessionId });
  await until(() => removing, "the log to be on its way out");
  await expect(
    c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") }),
  ).rejects.toMatchObject({ code: -32002 });
  expect(fake.log.launches).toBe(launches);
  release();
  await deleting;
});

/** What the agent was told when the daemon asked it to resume, after a daemon restart and one prompt. */
const resumeMeta = async (stopReason: string | undefined, prompts: number) => {
  const first = await start(fakeAgent(stopReason === undefined ? {} : { stopReason }));
  const c = await connectClient(first.daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  for (let i = 0; i < prompts; i++) {
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(`turn ${i}`) });
    await until(() => c.ended() >= i + 1, "the turn");
  }
  await first.daemon.close();
  open = [];

  const second = await start();
  const d = await connectClient(second.daemon);
  await d.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await d.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("after") });
  await until(() => d.ended() >= 1, "the turn after the restart");
  return (second.fake.log.resumes[0]?._meta ?? {}) as Record<string, unknown>;
};

test("the agent is told, when it is started again, that a turn of the session was answered", async () => {
  expect((await resumeMeta(undefined, 1))["cycle/hadTurn"]).toBe(true);
});

test("a session with no turn yet is resumed with no such word: the agent has nothing of it", async () => {
  expect((await resumeMeta(undefined, 0))["cycle/hadTurn"]).toBeUndefined();
});

test("a turn that ended in an error proves nothing about the agent's own record", async () => {
  expect((await resumeMeta("error", 1))["cycle/hadTurn"]).toBeUndefined();
});

test("tool input and output are kept without credentials: on disk, live, and in a replay", async () => {
  const key = `sk-ant-${"q".repeat(24)}`;
  const secrets = [key, "hunter2-value", "cookie-value", "form-answer-value"];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ say, ask }) => {
        await say({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Bash",
          status: "in_progress",
          rawInput: {
            command: "curl https://example.test",
            env: { ANTHROPIC_API_KEY: key, HOME: "/home/x" },
            headers: [{ name: "Cookie", value: "cookie-value" }],
          },
        });
        await ask({
          subject: {
            type: "tool_call",
            toolCall: { toolCallId: "t1", rawInput: { password: "hunter2-value", cwd: "/tmp" } },
          },
        });
        await say({
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          rawOutput: [{ type: "text", text: `ANTHROPIC_API_KEY=${key}\nUSER=me` }],
        });
      },
    }),
  );
  const live = await connectClient(daemon, { onPermission: () => "allow" });
  const { sessionId } = await live.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await live.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await live.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(
    () => live.seen.some((s) => (s.update as { status?: string }).status === "completed"),
    "the tool to finish",
  );

  const late = await connectClient(daemon);
  await late.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  expect(late.seen.some((s) => (s.update as { status?: string }).status === "completed")).toBe(
    true,
  );

  const disk = await readFile(join(dir, "sessions", `${sessionId}.jsonl`), "utf8").catch(() => "");
  expect(disk).toContain("tool_call");
  const everywhere = [
    disk,
    JSON.stringify(live.seen),
    JSON.stringify(live.permissions),
    JSON.stringify(late.seen),
  ];
  for (const where of everywhere) for (const secret of secrets) expect(where).not.toContain(secret);
  // What a person needs to read the call is still there.
  expect(disk).toContain("curl https://example.test");
  expect(disk).toContain("/home/x");
  expect(disk).toContain("USER=me");
  expect(JSON.stringify(live.permissions)).toContain("/tmp");
});

test("a form's answer stays out of the log", async () => {
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        await elicit();
      },
    }),
  );
  const c = await connectClient(daemon, {
    onElicitation: () => ({ action: "accept", content: { pick: "form-answer-value" } }),
  });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.elicitations.length === 1, "the form");
  await Bun.sleep(50);
  const disk = await readFile(join(dir, "sessions", `${sessionId}.jsonl`), "utf8");
  expect(disk).not.toContain("form-answer-value");
});
