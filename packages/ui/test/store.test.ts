import { expect, test } from "bun:test";
import type { SessionUpdate } from "@cycle/acp";
import type {
  AppEvent,
  CycleBridge,
  HostConfig,
  PermissionRequest,
  SessionSnapshot,
  SessionSummary,
} from "../src/api.ts";
import { applyUpdate, emptyConversation } from "../src/model/index.ts";
import { AppStore, viewKey } from "../src/store/index.ts";

const LOCAL: HostConfig = { id: "local", name: "This computer", kind: "local" };
const summary = (sessionId: string): SessionSummary => ({
  hostId: "local",
  sessionId,
  cwd: "/work",
  archived: false,
  agent: "fake",
  state: "idle",
  lastSeq: 0,
});
const text = (t: string, id = "a") =>
  ({
    sessionUpdate: "agent_message_chunk",
    messageId: id,
    content: { type: "text", text: t },
  }) as SessionUpdate;
const idle = (extra: object = {}) =>
  ({ sessionUpdate: "state_update", state: "idle", ...extra }) as SessionUpdate;

/** A bridge that records what it is asked, answers from a script, and lets a test send events. */
const fakeBridge = (
  options: {
    snapshot?: () => SessionSnapshot | Promise<SessionSnapshot>;
    connected?: boolean;
  } = {},
) => {
  const calls: [string, ...unknown[]][] = [];
  let listener: ((event: AppEvent) => void) | undefined;
  const record =
    <A extends unknown[], R>(name: string, result: (...args: A) => R) =>
    (...args: A): R => {
      calls.push([name, ...args]);
      return result(...args);
    };
  const bridge: CycleBridge = {
    onEvent: (l) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    hosts: record("hosts", async () => ({
      hosts: [LOCAL],
      status: [
        {
          hostId: "local",
          state: options.connected ? ("connected" as const) : ("closed" as const),
        },
      ],
    })),
    saveHost: record("saveHost", async () => {}),
    removeHost: record("removeHost", async () => {}),
    connect: record("connect", async () => {}),
    disconnect: record("disconnect", async () => {}),
    sessions: record("sessions", async () => [summary("s1")]),
    createSession: record("createSession", async () => "s2"),
    openSession: record(
      "openSession",
      async () =>
        (await options.snapshot?.()) ?? {
          conversation: emptyConversation(),
          permissions: [],
          version: 0,
        },
    ),
    prompt: record("prompt", async () => {}),
    cancel: record("cancel", async () => {}),
    setSessionConfig: record("setSessionConfig", async () => {}),
    renameSession: record("renameSession", async () => {}),
    archiveSession: record("archiveSession", async () => {}),
    deleteSession: record("deleteSession", async () => {}),
    answerPermission: record("answerPermission", async () => {}),
    agents: record("agents", async () => [
      { id: "fake", name: "Fake", available: true, configSchema: {} },
    ]),
    agentDefaults: record("agentDefaults", async () => ({})),
    setAgentDefaults: record("setAgentDefaults", async () => {}),
    chooseDirectory: record("chooseDirectory", async () => "/chosen"),
  };
  return {
    bridge,
    calls,
    emit: (event: AppEvent) => listener?.(event),
    named: (n: string) => calls.filter((c) => c[0] === n),
  };
};

const update = (version: number, u: SessionUpdate, sessionId = "s1"): AppEvent => ({
  type: "update",
  hostId: "local",
  sessionId,
  update: u,
  version,
});

const opened = async (script = fakeBridge()) => {
  const store = new AppStore(script.bridge);
  await store.start();
  await store.selectSession("s1");
  return { store, ...script };
};

test("starts: reads the hosts, connects to the first, and lists its sessions and agents", async () => {
  const { bridge, named } = fakeBridge();
  const store = new AppStore(bridge);
  await store.start();
  const s = store.getState();
  expect(s.ready).toBe(true);
  expect(s.selectedHost).toBe("local");
  expect(named("connect")).toHaveLength(1);
  expect(s.sessions.local?.map((x) => x.sessionId)).toEqual(["s1"]);
  expect(s.agents.local?.map((a) => a.id)).toEqual(["fake"]);
});

test("does not connect again to a host that is already connected", async () => {
  const { bridge, named } = fakeBridge({ connected: true });
  const store = new AppStore(bridge);
  await store.start();
  expect(named("connect")).toHaveLength(0);
});

test("opening a session shows what main has, and then each event in turn", async () => {
  const history = [text("Hel"), text("lo")].reduce(applyUpdate, emptyConversation());
  const { store, emit } = await opened(
    fakeBridge({ snapshot: () => ({ conversation: history, permissions: [], version: 2 }) }),
  );
  const key = viewKey("local", "s1");
  expect(store.getState().views[key]?.version).toBe(2);
  emit(update(3, text("!")));
  emit(update(4, idle({ stopReason: "end_turn" })));
  const view = store.getState().views[key];
  expect(view?.version).toBe(4);
  expect(view?.conversation.turns).toBe(1);
  expect(JSON.stringify(view?.conversation.items)).toContain("Hello!");
});

test("an event it has already seen is ignored", async () => {
  const { store, emit } = await opened(
    fakeBridge({
      snapshot: () => ({ conversation: emptyConversation(), permissions: [], version: 5 }),
    }),
  );
  emit(update(5, text("again")));
  emit(update(3, text("older")));
  expect(store.getState().views[viewKey("local", "s1")]?.conversation.items).toEqual([]);
});

test("a missed event makes it ask main for the session again", async () => {
  let version = 1;
  const script = fakeBridge({
    snapshot: () => ({
      conversation: [text(`v${version}`)].reduce(applyUpdate, emptyConversation()),
      permissions: [],
      version,
    }),
  });
  const { store, emit, named } = await opened(script);
  expect(named("openSession")).toHaveLength(1);
  version = 9;
  emit(update(4, text("skipped ahead")));
  await Bun.sleep(10);
  expect(named("openSession")).toHaveLength(2);
  expect(store.getState().views[viewKey("local", "s1")]?.version).toBe(9);
});

test("events that come while a session is being read are applied after it, in order", async () => {
  let release: (s: SessionSnapshot) => void = () => {};
  const script = fakeBridge({
    snapshot: () => new Promise<SessionSnapshot>((resolve) => (release = resolve)),
  });
  const store = new AppStore(script.bridge);
  await store.start();
  const selecting = store.selectSession("s1");
  await Bun.sleep(5);
  // Two events overtake the answer; one of them was already in the snapshot.
  script.emit(update(1, text("seen")));
  script.emit(update(2, text(" and new")));
  release({
    conversation: [text("seen")].reduce(applyUpdate, emptyConversation()),
    permissions: [],
    version: 1,
  });
  await selecting;
  const view = store.getState().views[viewKey("local", "s1")];
  expect(view?.loading).toBe(false);
  expect(view?.version).toBe(2);
  expect(JSON.stringify(view?.conversation.items)).toContain("seen and new");
});

test("a permission request appears and closes", async () => {
  const request: PermissionRequest = {
    key: "local:s1:p1",
    hostId: "local",
    sessionId: "s1",
    title: "Allow Bash?",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  };
  const { store, emit, named } = await opened();
  emit({ type: "permission", request, version: 1 });
  expect(store.getState().views[viewKey("local", "s1")]?.permissions).toEqual([request]);
  await store.answerPermission(request.key, "allow");
  expect(named("answerPermission")).toEqual([["answerPermission", "local:s1:p1", "allow"]]);
  emit({
    type: "permission-closed",
    hostId: "local",
    sessionId: "s1",
    key: request.key,
    version: 2,
  });
  expect(store.getState().views[viewKey("local", "s1")]?.permissions).toEqual([]);
});

test("sends a prompt, ignoring an empty one, and can cancel", async () => {
  const { store, named } = await opened();
  await store.send("   ");
  expect(named("prompt")).toHaveLength(0);
  await store.send("hello");
  expect(named("prompt")).toEqual([["prompt", "local", "s1", "hello"]]);
  await store.cancel();
  expect(named("cancel")).toHaveLength(1);
});

test("what goes wrong is kept for the user, without Electron's wrapping, and can be dismissed", async () => {
  const script = fakeBridge();
  script.bridge.prompt = async () => {
    throw new Error("Error invoking remote method 'cycle:prompt': Error: The session is working");
  };
  const { store } = await opened(script);
  await store.send("hi");
  expect(store.getState().error).toBe("The session is working");
  store.dismissError();
  expect(store.getState().error).toBeUndefined();
});

test("a session that cannot be opened is not left half-shown", async () => {
  const script = fakeBridge({
    snapshot: () => {
      throw new Error("No such session");
    },
  });
  const store = new AppStore(script.bridge);
  await store.start();
  await store.selectSession("gone");
  expect(store.getState().error).toBe("No such session");
  expect(store.getState().views[viewKey("local", "gone")]).toBeUndefined();
});

test("creating a session opens it, and deleting one clears it", async () => {
  const { store, named } = await opened();
  await store.createSession({ cwd: "/work", agent: "fake" });
  expect(named("createSession")).toEqual([
    ["createSession", "local", { cwd: "/work", agent: "fake" }],
  ]);
  expect(store.getState().selectedSession).toBe("s2");
  await store.deleteSession("s2");
  expect(store.getState().selectedSession).toBeUndefined();
  expect(store.getState().views[viewKey("local", "s2")]).toBeUndefined();
});

test("follows the status of hosts, lists of sessions, and changes to defaults", async () => {
  const { store, emit } = await opened();
  emit({ type: "host-status", hostId: "local", state: "reconnecting", error: "lost" });
  expect(store.getState().status.local).toEqual({
    hostId: "local",
    state: "reconnecting",
    error: "lost",
  });
  emit({ type: "sessions", hostId: "local", sessions: [summary("s1"), summary("s9")] });
  expect(store.getState().sessions.local).toHaveLength(2);
  emit({ type: "agent-defaults", hostId: "local", agent: "fake" });
  expect(store.getState().defaultsRevision.local).toBe(1);
});

test("subscribers hear every change, and stop hearing when they leave", async () => {
  const { bridge, emit } = fakeBridge();
  const store = new AppStore(bridge);
  let heard = 0;
  const leave = store.subscribe(() => heard++);
  await store.start();
  const before = heard;
  emit({ type: "host-status", hostId: "local", state: "connected" });
  expect(heard).toBe(before + 1);
  leave();
  emit({ type: "host-status", hostId: "local", state: "closed" });
  expect(heard).toBe(before + 1);
});
