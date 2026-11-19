import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "@cycle/daemon";
import { type Channel, connectUnix } from "@cycle/transport/client";
import { listenUnix } from "@cycle/transport/server";
import { type AppEvent, applyUpdate, type EnvironmentConfig, emptyConversation } from "@cycle/ui";
import { fakeAgent } from "../../../packages/daemon/test/fake-agent.ts";
import { type AttentionNotice, ConnectionManager } from "../src/main/manager.ts";
import { fileSettings, LOCAL_ENVIRONMENT } from "../src/main/settings.ts";

let dir: string;
let cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-"));
});
afterEach(async () => {
  for (const clean of cleanup.reverse()) await clean();
  cleanup = [];
  await rm(dir, { recursive: true, force: true });
});

const until = async (condition: () => boolean, what: string, ms = 3_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

/** A daemon on a socket with a fake agent, and managers that reach it. */
const setup = async (fake = fakeAgent(), daemonVersion?: string) => {
  const daemon = await Daemon.start({
    dataDir: join(dir, "daemon"),
    agents: [fake.definition],
    ...(daemonVersion !== undefined ? { version: daemonVersion } : {}),
  });
  const socket = join(dir, "d.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => void daemon.accept(stream),
  });
  cleanup.push(async () => {
    server.close();
    await daemon.close();
  });
  const channels: Channel[] = [];
  /** Managers (by name) that cannot reach the daemon for now. */
  const held = new Set<string>();
  const manager = async (
    name = "app",
    appVersion?: string,
    attention?: (notice: AttentionNotice) => void,
  ) => {
    const events: AppEvent[] = [];
    const m = new ConnectionManager({
      settings: fileSettings(join(dir, `settings-${name}.json`)),
      channelFor: () => async () => {
        if (held.has(name)) throw new Error("the network is down");
        const channel = await connectUnix(socket);
        channels.push(channel);
        return channel;
      },
      emit: (event) => events.push(event),
      backoff: { first: 10, max: 50 },
      ...(appVersion !== undefined ? { appVersion } : {}),
      ...(attention !== undefined ? { attention } : {}),
    });
    await m.init();
    cleanup.push(() => m.close());
    return { m, events };
  };
  return {
    fake,
    manager,
    held,
    drop: () => {
      for (const channel of channels.splice(0)) channel.close();
    },
  };
};

/** The first of a list that must not be empty. */
const first = <T>(items: T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error("expected something, found nothing");
  return item;
};

/** A session is in the list from its first message (docs/protocol.md §6): say something in it, and wait for the list. */
const said = async (m: ConnectionManager, id: string, words = "hi") => {
  await m.prompt("local", id, words);
  const started = Date.now();
  while (!(await m.sessions("local")).some((s) => s.sessionId === id)) {
    if (Date.now() - started > 3_000)
      throw new Error("timed out waiting for the session to be listed");
    await Bun.sleep(10);
  }
};

const of = <T extends AppEvent["type"]>(events: AppEvent[], type: T) =>
  events.filter((e): e is Extract<AppEvent, { type: T }> => e.type === type);

test("connects, creates a session, and lists it", async () => {
  const { manager } = await setup();
  const { m, events } = await manager();
  await m.connect("local");
  expect(of(events, "environment-status").map((e) => e.state)).toEqual(["connecting", "connected"]);
  const id = await m.createSession("local", { cwd: "/tmp" });
  // Nothing said in it yet: not in the list.
  expect(await m.sessions("local")).toEqual([]);
  await said(m, id);
  const sessions = await m.sessions("local");
  // Its agent is running, so it is idle and not stopped.
  expect(sessions).toMatchObject([
    { sessionId: id, cwd: "/tmp", agent: "fake", archived: false, state: "idle" },
  ]);
  expect(of(events, "sessions").length).toBeGreaterThan(0);
  // What the daemon said it can do reaches the page with the connection's state.
  expect(of(events, "environment-status").at(-1)?.capabilities).toEqual({
    queue: true,
    steer: true,
    files: true,
    folders: true,
    filesInFolder: true,
    trust: true,
  });
  expect((await m.agents("local")).map((a) => a.id)).toEqual(["fake"]);
});

test("an agent that takes images says so, and a message of blocks reaches it as the same blocks", async () => {
  const fake = fakeAgent({}, { promptCapabilities: { image: {} } });
  const { manager } = await setup(fake);
  const { m } = await manager();
  await m.connect("local");
  // What the composer looks at to decide whether to offer an attach button.
  const [agent] = await m.agents("local");
  expect(agent?.promptCapabilities?.image).toEqual({});
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  const picture = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
  await m.prompt("local", id, [{ type: "text", text: "what is this" }, picture]);
  await until(() => fake.log.blocks.length === 1, "the agent to be asked");
  expect(fake.log.blocks[0]).toEqual([{ type: "text", text: "what is this" }, picture]);
  // A plain text still goes as it always did.
  await m.prompt("local", id, "and this");
  await until(() => fake.log.blocks.length === 2, "the second prompt");
  expect(fake.log.blocks[1]).toEqual([{ type: "text", text: "and this" }]);
});

test("an image to an agent that did not say it takes images is refused, and nothing reaches it", async () => {
  const fake = fakeAgent();
  const { manager } = await setup(fake);
  const { m } = await manager();
  await m.connect("local");
  const [agent] = await m.agents("local");
  // No word of images: the interface has no attach button for this agent.
  expect(agent?.promptCapabilities?.image).toBeUndefined();
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await expect(
    m.prompt("local", id, [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]),
  ).rejects.toThrow();
  expect(fake.log.blocks).toHaveLength(0);
});

test("a session opened after the fact comes whole, and its version counts the events", async () => {
  const { manager } = await setup();
  const { m, events } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  const opened = await m.openSession("local", id);
  expect(opened.version).toBeGreaterThanOrEqual(0);
  await m.prompt("local", id, "hello");
  await until(
    () =>
      of(events, "update").some(
        (e) => (e.update as { stopReason?: string }).stopReason === "end_turn",
      ),
    "the turn",
  );

  // The renderer reloads: it asks again and is given everything.
  const snapshot = await m.openSession("local", id);
  expect(snapshot.conversation.turns).toBe(1);
  expect(snapshot.conversation.items.map((i) => i.kind)).toEqual(["user", "agent"]);
  const updates = of(events, "update").filter((e) => e.sessionId === id);
  expect(snapshot.version).toBe(updates.at(-1)?.version as number);
  // Versions go up by one, so a renderer can tell if it missed any.
  expect(updates.map((e) => e.version)).toEqual(updates.map((_, n) => first(updates).version + n));
  // The conversation main holds is what applying the events one by one gives.
  const rebuilt = updates.reduce((c, e) => applyUpdate(c, e.update), {
    ...emptyConversation(),
    replaying: true,
  });
  expect(rebuilt).toEqual(snapshot.conversation);
});

test("opening a session twice at once watches it once", async () => {
  const { manager } = await setup();
  const { m } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  const [a, b] = await Promise.all([m.openSession("local", id), m.openSession("local", id)]);
  expect(a.version).toBe(b.version);
});

test("a permission request is shown, held for a reloaded renderer, and answered", async () => {
  const outcomes: unknown[] = [];
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const { m, events } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  await until(() => of(events, "permission").length === 1, "the request");
  const request = first(of(events, "permission")).request;
  expect(request).toMatchObject({ environmentId: "local", sessionId: id, title: "Allow it?" });
  expect(request.options.map((o) => o.optionId)).toEqual(["allow", "deny"]);

  // A renderer that reloads is given the request that is still waiting.
  const snapshot = await m.openSession("local", id);
  expect(snapshot.permissions.map((p) => p.key)).toEqual([request.key]);

  await m.answerPermission(request.key, "allow");
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
  expect(of(events, "permission-closed").map((e) => e.key)).toEqual([request.key]);
  expect((await m.openSession("local", id)).permissions).toEqual([]);
});

test("a request answered by another client is closed here", async () => {
  const outcomes: unknown[] = [];
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const mine = await manager("mine");
  const theirs = await manager("theirs");
  await mine.m.connect("local");
  await theirs.m.connect("local");
  const id = await mine.m.createSession("local", { cwd: "/tmp" });
  await mine.m.openSession("local", id);
  // The other client finds it in the list once something is said in it, and is asked too.
  await mine.m.prompt("local", id, "ask");
  await until(() => of(mine.events, "permission").length === 1, "the request");
  const started = Date.now();
  while (!(await theirs.m.sessions("local")).some((s) => s.sessionId === id)) {
    if (Date.now() - started > 3_000) throw new Error("timed out waiting for the list");
    await Bun.sleep(10);
  }
  await theirs.m.openSession("local", id);
  await until(
    () =>
      of(mine.events, "permission").length === 1 && of(theirs.events, "permission").length === 1,
    "both to be asked",
  );

  await theirs.m.answerPermission(first(of(theirs.events, "permission")).request.key, "deny");
  await until(() => of(mine.events, "permission-closed").length === 1, "the request to close here");
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ outcome: { optionId: "deny" } });
});

test("a connection that drops is picked up again, and a request still open is not shown twice", async () => {
  const outcomes: unknown[] = [];
  const { manager, drop } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const { m, events } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  await until(() => of(events, "permission").length === 1, "the request");

  drop();
  await until(
    () => of(events, "environment-status").some((e) => e.state === "reconnecting"),
    "the loss",
  );
  // What the daemon can do is not forgotten while the line is down.
  expect(
    of(events, "environment-status").find((e) => e.state === "reconnecting")?.capabilities,
  ).toEqual({
    queue: true,
    steer: true,
    files: true,
    folders: true,
    filesInFolder: true,
    trust: true,
  });
  await until(
    () => of(events, "environment-status").at(-1)?.state === "connected",
    "the reconnect",
  );
  // The daemon asked again on the new connection: still one request on screen, not two.
  await Bun.sleep(100);
  expect(of(events, "permission")).toHaveLength(1);
  const key = first(of(events, "permission")).request.key;
  await m.answerPermission(key, "allow");
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { optionId: "allow" } });
});

test("renames, archives and deletes a session, and the list follows", async () => {
  const { manager } = await setup();
  const { m } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await said(m, id);
  await m.renameSession("local", id, "Named");
  await m.archiveSession("local", id, true);
  expect(await m.sessions("local")).toMatchObject([{ title: "Named", archived: true }]);
  await m.deleteSession("local", id);
  expect(await m.sessions("local")).toEqual([]);
});

test("an agent's defaults are read and set", async () => {
  const { manager } = await setup();
  const { m, events } = await manager();
  await m.connect("local");
  expect(await m.agentDefaults("local", "fake")).toEqual({});
  await m.setAgentDefaults("local", "fake", { mode: "plan" });
  expect(await m.agentDefaults("local", "fake")).toEqual({ mode: "plan" });
  await until(() => of(events, "agent-defaults").length === 1, "the change");
});

test("an environment whose address ssh would read as an option is refused, not saved", async () => {
  const { manager } = await setup();
  const { m } = await manager("opt");
  await expect(
    m.saveEnvironment({
      id: "x",
      name: "X",
      kind: "remote",
      transport: { type: "ssh", host: "-oProxyCommand=touch /tmp/x" },
    }),
  ).rejects.toThrow("not an environment");
  expect((await m.environments()).environments.map((e) => e.id)).toEqual(["local"]);
});

test("environments are kept across runs, and the local one stays", async () => {
  const { manager } = await setup();
  const first = await manager("a");
  const box: EnvironmentConfig = {
    id: "box",
    name: "Box",
    kind: "remote",
    transport: { type: "ssh", host: "me@box" },
  };
  await first.m.saveEnvironment(box);
  expect((await first.m.environments()).environments.map((h) => h.id)).toEqual(["local", "box"]);
  const again = new ConnectionManager({
    settings: fileSettings(join(dir, "settings-a.json")),
    channelFor: () => async () => {
      throw new Error("no");
    },
    emit: () => {},
  });
  await again.init();
  expect((await again.environments()).environments).toEqual([LOCAL_ENVIRONMENT, box]);
  await expect(again.removeEnvironment("local")).rejects.toThrow("cannot be removed");
  await again.removeEnvironment("box");
  expect((await again.environments()).environments).toEqual([LOCAL_ENVIRONMENT]);
});

test("a host that cannot be reached ends closed, with why", async () => {
  const events: AppEvent[] = [];
  const m = new ConnectionManager({
    settings: fileSettings(join(dir, "s.json")),
    channelFor: () => async () => {
      throw new Error("Host key verification failed");
    },
    emit: (e) => events.push(e),
  });
  await m.init();
  await expect(m.connect("local")).rejects.toThrow("Host key verification failed");
  expect(of(events, "environment-status").at(-1)).toMatchObject({
    state: "closed",
    error: "Host key verification failed",
  });
  expect((await m.environments()).status[0]?.state).toBe("closed");
});

const far: EnvironmentConfig = {
  id: "far",
  name: "Far",
  kind: "remote",
  transport: { type: "ssh", host: "example" },
};
const connectedStatus = (events: AppEvent[], environmentId: string) =>
  events.findLast(
    (e): e is Extract<AppEvent, { type: "environment-status" }> =>
      e.type === "environment-status" &&
      e.environmentId === environmentId &&
      e.state === "connected",
  );

test("a remote host whose daemon is older than the app is told so, with what to run on it", async () => {
  const { manager } = await setup(fakeAgent(), "0.1.0");
  const { m, events } = await manager("app", "0.1.1");
  await m.saveEnvironment(far);
  await m.connect("far");
  const daemon = connectedStatus(events, "far")?.daemon;
  expect(daemon?.version).toBe("0.1.0");
  expect(daemon?.upgrade).toContain("releases/download/v0.1.1/cycle-linux-x64.tar.gz");
  expect(daemon?.upgrade).toContain("sha256sum -c");
  expect(daemon?.upgrade).toContain("install.sh");
});

test("a daemon that is the same, newer, or a development build is not nagged about", async () => {
  for (const version of ["0.1.1", "0.2.0", undefined]) {
    const { manager } = await setup(fakeAgent(), version);
    const { m, events } = await manager("app", "0.1.1");
    await m.saveEnvironment(far);
    await m.connect("far");
    expect(connectedStatus(events, "far")?.daemon?.upgrade).toBeUndefined();
    await m.close();
    for (const clean of cleanup.splice(0).reverse()) await clean();
  }
});

test("the local host is not compared: the app carries it", async () => {
  const { manager } = await setup(fakeAgent(), "0.0.1");
  const { m, events } = await manager("app", "0.1.1");
  await m.connect("local");
  expect(connectedStatus(events, "local")?.daemon).toBeUndefined();
});

test("a message sent while the agent works waits in the conversation, and can be taken back", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { manager, fake } = await setup(fakeAgent({ onPrompt: () => held }));
  const { m } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "first");
  await m.prompt("local", id, "second");
  await m.prompt("local", id, "third");
  const waiting = async () => (await m.openSession("local", id)).conversation.queue;
  // `until` takes a plain condition: look, and wait for the two to be there.
  let queue = await waiting();
  for (let tries = 0; queue.length < 2 && tries < 400; tries++) {
    await Bun.sleep(5);
    queue = await waiting();
  }
  const [second, third] = queue;
  expect(queue.map((p) => p.prompt)).toEqual([
    [{ type: "text", text: "second" }],
    [{ type: "text", text: "third" }],
  ]);
  expect(second?.prompt).toEqual([{ type: "text", text: "second" }]);
  // The person changes their mind about the second.
  expect(await m.dequeue("local", id, second?.queueId ?? "")).toEqual([
    { type: "text", text: "second" },
  ]);
  release();
  await until(() => fake.log.prompts.length === 2, "the third to be sent");
  expect(fake.log.prompts).toEqual(["first", "third"]);
  expect(third?.queueId).toBeString();
  // The snapshots that say so come after the agent got it.
  queue = await waiting();
  for (let tries = 0; queue.length > 0 && tries < 400; tries++) {
    await Bun.sleep(5);
    queue = await waiting();
  }
  expect(queue).toEqual([]);
});

test("a session that asks and then finishes is reported to the main process, and the first list is not a change", async () => {
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask();
      },
    }),
  );
  const notices: AttentionNotice[] = [];
  const { m, events } = await manager("app", undefined, (n) => notices.push(n));
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  // Reading the list for the first time, and creating a session, tell nothing.
  expect(notices).toEqual([]);
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  await until(() => of(events, "permission").length === 1, "the request");
  await until(() => notices.length === 1, "the session to be reported as asking");
  expect(notices[0]).toMatchObject({
    environmentId: "local",
    environmentName: LOCAL_ENVIRONMENT.name,
    kind: "needs-you",
    session: { sessionId: id, state: "requires_action" },
  });
  await m.answerPermission(first(of(events, "permission")).request.key, "allow");
  await until(() => notices.length === 2, "the session to be reported as done");
  expect(notices[1]).toMatchObject({ kind: "finished", session: { sessionId: id, state: "idle" } });
});

test("the first list a manager reads is not a change, even when a session in it is asking", async () => {
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask();
      },
    }),
  );
  const first = await manager("first");
  await first.m.connect("local");
  const id = await first.m.createSession("local", { cwd: "/tmp" });
  await first.m.openSession("local", id);
  await first.m.prompt("local", id, "ask");
  await until(() => of(first.events, "permission").length === 1, "the request");
  // Another app starts while the session is asking: what it is told is the list, not a change in it.
  const notices: AttentionNotice[] = [];
  const second = await manager("second", undefined, (n) => notices.push(n));
  await second.m.connect("local");
  const listed = await second.m.sessions("local");
  expect(listed.map((s) => s.state)).toEqual(["requires_action"]);
  await Bun.sleep(50);
  expect(notices).toEqual([]);
});

test("a session made elsewhere is reported when it finishes, even if it is first listed done", async () => {
  const { manager } = await setup();
  const notices: AttentionNotice[] = [];
  const watcher = await manager("watcher", undefined, (n) => notices.push(n));
  await watcher.m.connect("local");
  expect(await watcher.m.sessions("local")).toEqual([]);
  // Another client starts a session: its first turn may well be over by the time this one reads the list.
  const maker = await manager("maker");
  await maker.m.connect("local");
  const id = await maker.m.createSession("local", { cwd: "/tmp" });
  await maker.m.prompt("local", id, "hi");
  await until(
    () => notices.some((n) => n.kind === "finished" && n.session.sessionId === id),
    "the finished session to be reported",
  );
  expect(notices.filter((n) => n.session.sessionId === id).map((n) => n.kind)).toEqual([
    "finished",
  ]);
});

test("a hook that fails does not stop the list from being read, and a manager without one says nothing", async () => {
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask();
      },
    }),
  );
  const { m, events } = await manager("app", undefined, () => {
    throw new Error("no notification today");
  });
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  // The list still reaches the renderer, with the session asking.
  await until(
    () => of(events, "sessions").some((e) => e.sessions.some((s) => s.state === "requires_action")),
    "the renderer to be told the session is asking",
  );
  const quiet = await manager("quiet");
  await quiet.m.connect("local");
  expect(quiet.events.length).toBeGreaterThan(0);
});

test("a session deleted elsewhere while the connection was away is gone here, and the rest is as before", async () => {
  const { manager, held, drop } = await setup();
  const a = await manager("a");
  await a.m.connect("local");
  const keep = await a.m.createSession("local", { cwd: "/tmp" });
  const doomed = await a.m.createSession("local", { cwd: "/tmp" });
  await a.m.openSession("local", keep);
  await a.m.openSession("local", doomed);
  await said(a.m, keep);
  await said(a.m, doomed);
  const b = await manager("b");
  await b.m.connect("local");

  held.add("a");
  drop();
  await until(
    () => of(a.events, "environment-status").some((e) => e.state === "reconnecting"),
    "the loss",
  );
  await until(
    () => of(b.events, "environment-status").at(-1)?.state === "connected",
    "b to be back",
  );
  await b.m.deleteSession("local", doomed);
  held.delete("a");
  await until(
    () => of(a.events, "environment-status").at(-1)?.state === "connected",
    "a to reconnect",
  );

  await until(() => of(a.events, "sessions").at(-1)?.sessions.length === 1, "the list to follow");
  expect(first(of(a.events, "sessions").slice(-1)).sessions.map((s) => s.sessionId)).toEqual([
    keep,
  ]);
  // The renderer is told, so it can drop the view and the dialogs of the session.
  expect(of(a.events, "session-gone")).toEqual([
    { type: "session-gone", environmentId: "local", sessionId: doomed },
  ]);
  await expect(a.m.openSession("local", doomed)).rejects.toThrow();
  // The session that is still there goes on being watched.
  const seen = of(a.events, "update").length;
  await a.m.prompt("local", keep, "still here");
  await until(() => of(a.events, "update").length > seen, "the healthy session to go on");
});

test("every host is connected, one that cannot be reached does not hold up the others, and why is kept for a renderer that asks later", async () => {
  const { manager } = await setup();
  const { m, events } = await manager("all");
  await m.saveEnvironment(far);
  // Same settings file, a manager whose far environment cannot be reached.
  const both = new ConnectionManager({
    settings: fileSettings(join(dir, "settings-all.json")),
    channelFor: (environment) => async () => {
      if (environment.id === "far") throw new Error("Host key verification failed");
      return connectUnix(join(dir, "d.sock"));
    },
    emit: (e) => events.push(e),
  });
  await both.init();
  cleanup.push(() => both.close());
  await both.connectAll();
  const { status } = await both.environments();
  expect(status.find((s) => s.environmentId === "local")?.state).toBe("connected");
  expect(status.find((s) => s.environmentId === "far")).toMatchObject({
    state: "closed",
    error: "Host key verification failed",
  });
});

test("the last list of a host that goes away is still given, and a host removed has none", async () => {
  const { manager } = await setup();
  const { m } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await said(m, id);
  expect((await m.environments()).sessions.local?.map((s) => s.sessionId)).toEqual([id]);
  await m.disconnect("local");
  const after = await m.environments();
  expect(after.status[0]?.state).toBe("closed");
  expect(after.sessions.local?.map((s) => s.sessionId)).toEqual([id]);
  await m.saveEnvironment(far);
  await m.removeEnvironment("far");
  expect((await m.environments()).sessions.far).toBeUndefined();
});

test("an environment's folders are listed through its daemon, and a path that is not a folder is refused", async () => {
  const { manager } = await setup();
  const { m, events } = await manager();
  await m.connect("local");
  expect(of(events, "environment-status").at(-1)?.capabilities?.folders).toBe(true);
  await mkdir(join(dir, "daemon", "wanted", "inner"), { recursive: true });
  const listed = await m.listFolders("local", join(dir, "daemon", "wanted"));
  expect(listed.folders).toEqual([{ name: "inner" }]);
  await expect(m.listFolders("local", "relative")).rejects.toThrow();
});

test("a session says when it last had something happen", async () => {
  const { manager } = await setup();
  const { m } = await manager();
  await m.connect("local");
  await said(m, await m.createSession("local", { cwd: "/tmp" }));
  const [session] = await m.sessions("local");
  expect(Number.isNaN(Date.parse(session?.updatedAt ?? ""))).toBe(false);
});
