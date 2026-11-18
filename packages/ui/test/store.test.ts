import { expect, test } from "bun:test";
import type { SessionUpdate } from "@cycle/acp";
import type { AppEvent, PermissionRequest, SessionSnapshot } from "../src/api.ts";
import { DraftStore } from "../src/draft.ts";
import { applyUpdate, emptyConversation, reduce } from "../src/model/index.ts";
import { AppStore, viewKey } from "../src/store/index.ts";

import { fakeBridge, idle, text } from "./fake-bridge.ts";

const update = (version: number, u: SessionUpdate, sessionId = "s1"): AppEvent => ({
  type: "update",
  hostId: "local",
  sessionId,
  update: u,
  version,
});

const opened = async (script = fakeBridge(), drafts?: DraftStore) => {
  const store = new AppStore(script.bridge, drafts ?? new DraftStore(undefined));
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
  const key = viewKey("local", "s1");
  store.drafts.setText(key, "   ");
  await store.send();
  expect(named("prompt")).toHaveLength(0);
  store.drafts.setText(key, "hello");
  await store.send();
  expect(named("prompt")).toEqual([["prompt", "local", "s1", [{ type: "text", text: "hello" }]]]);
  // The box is empty from the moment it went.
  expect(store.drafts.get(key).text).toBe("");
  await store.cancel();
  expect(named("cancel")).toHaveLength(1);
});

test("takes a queued prompt back, and an error says why it could not", async () => {
  const script = fakeBridge();
  script.bridge.dequeue = async (_host, _session, queueId) => {
    if (queueId === "gone")
      throw new Error(
        "Error invoking remote method 'cycle:dequeue': Error: That prompt is not waiting",
      );
    return [{ type: "text", text: "back" }];
  };
  const { store } = await opened(script);
  store.drafts.setText(viewKey("local", "s1"), "typing");
  expect(await store.dequeue("q1")).toEqual([{ type: "text", text: "back" }]);
  // It is in the box now, in front of what was being written.
  expect(store.drafts.get(viewKey("local", "s1")).text).toBe("back\n\ntyping");
  expect(await store.dequeue("gone")).toBeUndefined();
  expect(store.getState().error).toBe("That prompt is not waiting");
});

test("what goes wrong is kept for the user, without Electron's wrapping, and can be dismissed", async () => {
  const script = fakeBridge();
  script.bridge.prompt = async () => {
    throw new Error("Error invoking remote method 'cycle:prompt': Error: The session is working");
  };
  const { store } = await opened(script);
  store.drafts.setText(viewKey("local", "s1"), "hi");
  await store.send();
  expect(store.getState().error).toBe("The session is working");
  // What could not go is back in the box.
  expect(store.drafts.get(viewKey("local", "s1")).text).toBe("hi");
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

test("the update state is read at the start, follows main's events, and the user can ask for a check", async () => {
  const { bridge, named, emit } = fakeBridge();
  const store = new AppStore(bridge);
  await store.start();
  expect(store.getState().update).toEqual({ current: "0.1.0", kind: "idle" });
  emit({ type: "app-update", state: { current: "0.1.0", kind: "available", version: "0.2.0" } });
  expect(store.getState().update).toMatchObject({ kind: "available", version: "0.2.0" });
  await store.checkForUpdate();
  expect(named("checkForUpdate")).toHaveLength(1);
  expect(store.getState().update?.kind).toBe("up-to-date");
  await store.installUpdate();
  expect(named("installUpdate")).toHaveLength(1);
});

test("an install that main refuses shows its reason, in the words main used", async () => {
  const script = fakeBridge();
  script.bridge.installUpdate = async () => {
    throw new Error("Error invoking remote method 'cycle:installUpdate': Error: no room");
  };
  const store = new AppStore(script.bridge);
  await store.start();
  await store.installUpdate();
  expect(store.getState().error).toBe("no room");
});

const handBack = (texts: string[], reason = "cancelled") => ({
  sessionUpdate: "_cycle/queue_update",
  entries: [],
  reason,
  returned: texts.map((text, i) => ({ queueId: `${text}-${i}`, prompt: [{ type: "text", text }] })),
});

test("what the daemon hands back goes into that session's box once, even for a session not in view", async () => {
  const { store, emit } = await opened();
  const key = viewKey("local", "s1");
  store.drafts.setText(key, "later");
  emit({
    type: "update",
    hostId: "local",
    sessionId: "s1",
    update: handBack(["one", "two"]) as never,
    version: 1,
  });
  expect(store.drafts.get(key).text).toBe("one\n\ntwo\n\nlater");
  // Another update does not put it there again.
  emit({
    type: "update",
    hostId: "local",
    sessionId: "s1",
    update: { sessionUpdate: "_cycle/queue_update", entries: [] } as never,
    version: 2,
  });
  expect(store.drafts.get(key).text).toBe("one\n\ntwo\n\nlater");
});

test("a page that opens a session whose hand-back it has already taken does not take it again", async () => {
  const snapshot = () => ({
    conversation: reduce([handBack(["gone"]) as never]),
    permissions: [],
    version: 1,
  });
  const drafts = new DraftStore(undefined);
  const key = viewKey("local", "s1");
  drafts.markHandled(key, "gone-0");
  const { store } = await opened(fakeBridge({ connected: true, snapshot }), drafts);
  expect(store.drafts.get(key).text).toBe("");
  // One it has not taken is put in the box when the session opens: it came while nobody looked.
  const other = new DraftStore(undefined);
  const again = await opened(fakeBridge({ connected: true, snapshot }), other);
  expect(again.store.drafts.get(key).text).toBe("gone");
});

test("deleting a session forgets what was written for it", async () => {
  const { store } = await opened();
  const key = viewKey("local", "s1");
  store.drafts.setText(key, "never sent");
  await store.deleteSession("s1");
  expect(store.drafts.get(key).text).toBe("");
});
