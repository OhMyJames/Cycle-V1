import { expect, test } from "bun:test";
import { type AppEvent, createTranslator, enUS } from "@cycle/ui";
import { type NotifyWindow, notifyAttention } from "../src/main/attention.ts";
import type { AttentionNotice } from "../src/main/manager.ts";

const notice = (over: Partial<AttentionNotice> = {}): AttentionNotice => ({
  hostId: "local",
  hostName: "This computer",
  kind: "needs-you",
  session: {
    hostId: "local",
    sessionId: "s1",
    cwd: "/home/dev/cycle-v1",
    archived: false,
    agent: "claude",
    state: "requires_action",
    lastSeq: 3,
    title: "Approve the deploy",
  },
  ...over,
});

const rig = (options: { focused?: boolean; supported?: boolean; destroyed?: boolean } = {}) => {
  const calls: string[] = [];
  const shown: { title: string; subtitle?: string; body: string }[] = [];
  const emitted: AppEvent[] = [];
  let click: () => void = () => {};
  const window: NotifyWindow = {
    isFocused: () => options.focused ?? false,
    isDestroyed: () => options.destroyed ?? false,
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  const notify = notifyAttention({
    window: () => window,
    supported: () => options.supported ?? true,
    create: (n) => {
      shown.push(n);
      return {
        show: () => calls.push("notify"),
        on: (_event, listener) => {
          click = listener;
        },
      };
    },
    translator: createTranslator("en-US", enUS),
    emit: (event) => emitted.push(event),
  });
  return { notify, calls, shown, emitted, press: () => click() };
};

test("a session that asks is a notification with its title and what it wants", () => {
  const { notify, shown, calls } = rig();
  notify(notice());
  expect(shown).toEqual([{ title: "Approve the deploy", body: "Waiting for your answer" }]);
  expect(calls).toEqual(["notify"]);
});

test("what finished and what stopped say so, in words", () => {
  const finished = rig();
  finished.notify(notice({ kind: "finished" }));
  expect(finished.shown[0]?.body).toBe("Finished");
  const stopped = rig();
  stopped.notify(notice({ kind: "stopped" }));
  expect(stopped.shown[0]?.body).toBe("The agent stopped unexpectedly");
});

test("a session with no title is named by its folder, and one on another machine says which", () => {
  const { notify, shown } = rig();
  const { title: _gone, ...untitled } = notice().session;
  notify(
    notice({ hostId: "build", hostName: "build-1", session: { ...untitled, hostId: "build" } }),
  );
  expect(shown).toEqual([
    { title: "cycle-v1", subtitle: "build-1", body: "Waiting for your answer" },
  ]);
});

test("while the app is in front nothing is shown, and nor when the system cannot", () => {
  const front = rig({ focused: true });
  front.notify(notice());
  expect(front.shown).toEqual([]);
  const unsupported = rig({ supported: false });
  unsupported.notify(notice());
  expect(unsupported.shown).toEqual([]);
  const closed = rig({ destroyed: true });
  closed.notify(notice());
  expect(closed.shown).toEqual([]);
});

test("pressing it brings the window back and asks the page to show that session", () => {
  const { notify, press, calls, emitted } = rig();
  notify(notice());
  press();
  expect(calls).toEqual(["notify", "show", "focus"]);
  expect(emitted).toEqual([{ type: "focus-session", hostId: "local", sessionId: "s1" }]);
});
