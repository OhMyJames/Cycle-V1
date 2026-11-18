import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "@cycle/daemon";
import { type Channel, connectUnix } from "@cycle/transport/client";
import { listenUnix } from "@cycle/transport/server";
import { type AppEvent, applyUpdate, emptyConversation, type HostConfig } from "@cycle/ui";
import { fakeAgent } from "../../../packages/daemon/test/fake-agent.ts";
import { ConnectionManager } from "../src/main/manager.ts";
import { fileSettings, LOCAL_HOST } from "../src/main/settings.ts";

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
  const manager = async (name = "app", appVersion?: string) => {
    const events: AppEvent[] = [];
    const m = new ConnectionManager({
      settings: fileSettings(join(dir, `settings-${name}.json`)),
      channelFor: () => async () => {
        const channel = await connectUnix(socket);
        channels.push(channel);
        return channel;
      },
      emit: (event) => events.push(event),
      backoff: { first: 10, max: 50 },
      ...(appVersion !== undefined ? { appVersion } : {}),
    });
    await m.init();
    cleanup.push(() => m.close());
    return { m, events };
  };
  return {
    fake,
    manager,
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

const of = <T extends AppEvent["type"]>(events: AppEvent[], type: T) =>
  events.filter((e): e is Extract<AppEvent, { type: T }> => e.type === type);

test("connects, creates a session, and lists it", async () => {
  const { manager } = await setup();
  const { m, events } = await manager();
  await m.connect("local");
  expect(of(events, "host-status").map((e) => e.state)).toEqual(["connecting", "connected"]);
  const id = await m.createSession("local", { cwd: "/tmp" });
  const sessions = await m.sessions("local");
  // Its agent is running, so it is idle and not stopped.
  expect(sessions).toMatchObject([
    { sessionId: id, cwd: "/tmp", agent: "fake", archived: false, state: "idle" },
  ]);
  expect(of(events, "sessions").length).toBeGreaterThan(0);
  expect((await m.agents("local")).map((a) => a.id)).toEqual(["fake"]);
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
  expect(request).toMatchObject({ hostId: "local", sessionId: id, title: "Allow it?" });
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
  await theirs.m.openSession("local", id);
  await mine.m.prompt("local", id, "ask");
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
  await until(() => of(events, "host-status").some((e) => e.state === "reconnecting"), "the loss");
  await until(() => of(events, "host-status").at(-1)?.state === "connected", "the reconnect");
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

test("hosts are kept across runs, and the local one stays", async () => {
  const { manager } = await setup();
  const first = await manager("a");
  const box: HostConfig = { id: "box", name: "Box", kind: "ssh", host: "me@box" };
  await first.m.saveHost(box);
  expect((await first.m.hosts()).hosts.map((h) => h.id)).toEqual(["local", "box"]);
  const again = new ConnectionManager({
    settings: fileSettings(join(dir, "settings-a.json")),
    channelFor: () => async () => {
      throw new Error("no");
    },
    emit: () => {},
  });
  await again.init();
  expect((await again.hosts()).hosts).toEqual([LOCAL_HOST, box]);
  await expect(again.removeHost("local")).rejects.toThrow("cannot be removed");
  await again.removeHost("box");
  expect((await again.hosts()).hosts).toEqual([LOCAL_HOST]);
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
  expect(of(events, "host-status").at(-1)).toMatchObject({
    state: "closed",
    error: "Host key verification failed",
  });
  expect((await m.hosts()).status[0]?.state).toBe("closed");
});

const far: HostConfig = { id: "far", name: "Far", kind: "ssh", host: "example" };
const connectedStatus = (events: AppEvent[], hostId: string) =>
  events.findLast(
    (e): e is Extract<AppEvent, { type: "host-status" }> =>
      e.type === "host-status" && e.hostId === hostId && e.state === "connected",
  );

test("a remote host whose daemon is older than the app is told so, with what to run on it", async () => {
  const { manager } = await setup(fakeAgent(), "0.1.0");
  const { m, events } = await manager("app", "0.1.1");
  await m.saveHost(far);
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
    await m.saveHost(far);
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
