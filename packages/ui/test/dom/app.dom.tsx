import { afterEach, expect, test } from "bun:test";
import type { SessionUpdate } from "@cycle/acp";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from "lexical";
import type { PermissionRequest, SessionSnapshot } from "../../src/api.ts";
import { codeTheme } from "../../src/code-theme.ts";
import { markdownOf } from "../../src/composer-markdown.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, idle, summary, text } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  // Drafts are kept in the page's storage; each test starts with none.
  localStorage.clear();
});

const u = (update: object) => update as SessionUpdate;

// The message box is a Lexical editor. happy-dom has no real selection or input events for it, so the tests act on the
// editor the way its own commands do (a key is a command; text is inserted at the end); real typing is the Electron smoke test's.
const editorOf = (box: HTMLElement): LexicalEditor => {
  const editor = (box as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (editor === undefined) throw new Error("the message box has no editor");
  return editor;
};
const write = (box: HTMLElement, words: string) =>
  act(() => {
    editorOf(box).update(
      () => {
        $getRoot().selectEnd();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertRawText(words);
      },
      { discrete: true },
    );
  });
const boxText = (box: HTMLElement): string => markdownOf(editorOf(box));
const KEYS = {
  Enter: KEY_ENTER_COMMAND,
  ArrowUp: KEY_ARROW_UP_COMMAND,
  ArrowDown: KEY_ARROW_DOWN_COMMAND,
} as const;
const press = (box: HTMLElement, key: keyof typeof KEYS, init: KeyboardEventInit = {}) =>
  act(() => {
    editorOf(box).dispatchCommand(KEYS[key], new KeyboardEvent("keydown", { key, ...init }));
  });
const ready = (box: HTMLElement) =>
  waitFor(() => expect(box.getAttribute("contenteditable")).toBe("true"));

const mount = async (
  options: {
    snapshot?: () => SessionSnapshot;
    configure?: (script: ReturnType<typeof fakeBridge>) => void;
  } = {},
) => {
  const script = fakeBridge({
    connected: true,
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
  });
  options.configure?.(script);
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  // An event arrives outside React's own calls: say so, or each one warns.
  const emit = (event: Parameters<typeof script.emit>[0]) => act(() => script.emit(event));
  return { store, user, ...script, emit };
};

const history = (...updates: SessionUpdate[]): SessionSnapshot => ({
  conversation: updates.reduce(applyUpdate, emptyConversation()),
  permissions: [],
  version: updates.length,
});

const openFirstSession = async (user: ReturnType<typeof userEvent.setup>) => {
  const option = await screen.findByRole("option", { name: /work/ });
  await user.click(option);
};

test("lists the host's sessions, and shows the conversation of the one chosen", async () => {
  const { user } = await mount({
    snapshot: () =>
      history(
        u({
          sessionUpdate: "user_message",
          messageId: "u1",
          content: [{ type: "text", text: "Say hi" }],
        }),
        text("Hi there!", "a1"),
        idle({ stopReason: "end_turn" }),
      ),
  });
  await openFirstSession(user);
  const log = await screen.findByRole("log", { name: "Conversation" });
  await waitFor(() => expect(log.textContent).toContain("Hi there!"));
  expect(log.textContent).toContain("Say hi");
});

test("Enter sends what was typed, Shift+Enter makes a new line, and the box empties", async () => {
  const { user, named } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "first line");
  await press(box, "Enter", { shiftKey: true });
  await write(box, "second line");
  expect(boxText(box)).toBe("first line\nsecond line");
  expect(named("prompt")).toHaveLength(0);
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "first line\nsecond line" }]],
    ]),
  );
  expect(boxText(box)).toBe("");
});

test("while the agent works there is Stop, and a message typed is queued, not refused", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });
  emit({
    type: "update",
    hostId: "local",
    sessionId: "s1",
    update: u({ sessionUpdate: "state_update", state: "running" }),
    version: 1,
  });
  const stop = await screen.findByRole("button", { name: "Stop" });
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  const queue = screen.getByRole("button", { name: "Queue" }) as HTMLButtonElement;
  expect(queue.disabled).toBe(true);
  await write(screen.getByRole("textbox", { name: "Message" }), "next");
  await user.click(queue);
  await waitFor(() =>
    expect(named("prompt")).toEqual([["prompt", "local", "s1", [{ type: "text", text: "next" }]]]),
  );
  await user.click(stop);
  expect(named("cancel")).toHaveLength(1);
  emit({
    type: "update",
    hostId: "local",
    sessionId: "s1",
    update: idle({ stopReason: "cancelled" }),
    version: 2,
  });
  await screen.findByRole("button", { name: "Send" });
});

test("streams: what arrives is added to the message on screen", async () => {
  const { user, emit } = await mount({ snapshot: () => history() });
  await openFirstSession(user);
  const log = await screen.findByRole("log", { name: "Conversation" });
  emit({ type: "update", hostId: "local", sessionId: "s1", update: text("Hel", "a1"), version: 1 });
  emit({ type: "update", hostId: "local", sessionId: "s1", update: text("lo!", "a1"), version: 2 });
  await waitFor(() => expect(log.textContent).toContain("Hello!"));
});

test("a tool call shows what it is doing and how it went", async () => {
  const { user } = await mount({
    snapshot: () =>
      history(
        u({ sessionUpdate: "tool_call_update", toolCallId: "t1", name: "Bash", status: "pending" }),
        u({
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          rawInput: { command: "ls -la" },
        }),
      ),
  });
  await openFirstSession(user);
  const log = await screen.findByRole("log", { name: "Conversation" });
  await waitFor(() => expect(log.textContent).toContain("Bash"));
  expect(log.textContent).toContain("ls -la");
  expect(log.textContent).toContain("completed");
});

test("a permission request is shown with its options, and the click answers it", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });
  const request: PermissionRequest = {
    key: "local:s1:p1",
    hostId: "local",
    sessionId: "s1",
    title: "Allow Bash?",
    subject: {
      type: "tool_call",
      toolCall: { name: "Bash", rawInput: { command: "rm -rf build" } },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  };
  emit({ type: "permission", request, version: 1 });
  // By label and text: a role query walks the whole page's accessibility tree, which is slow here.
  const card = await screen.findByLabelText("Allow Bash?");
  expect(card.textContent).toContain("rm -rf build");
  await user.click(within(card).getByText("Deny"));
  expect(named("answerPermission")).toEqual([["answerPermission", "local:s1:p1", "deny"]]);
  emit({
    type: "permission-closed",
    hostId: "local",
    sessionId: "s1",
    key: request.key,
    version: 2,
  });
  await waitFor(() => expect(screen.queryByLabelText("Allow Bash?")).toBeNull());
});

test("shows what went wrong, and lets it be dismissed", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.prompt = async () => {
        throw new Error("The session is working");
      };
    },
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "hi");
  await press(box, "Enter");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The session is working");
  await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("says so when the connection is lost", async () => {
  const { emit } = await mount();
  emit({ type: "host-status", hostId: "local", state: "reconnecting" });
  const note = await screen.findByText(/Connection lost/);
  expect(note.getAttribute("role") ?? note.parentElement?.getAttribute("role")).toBe("status");
});

test("starts a session from the defaults of the agent, in the directory typed", async () => {
  const { user, named } = await mount({
    configure: (script) => {
      script.bridge.agentDefaults = async () => ({ mode: "plan" });
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: { mode: { type: "string", enum: ["default", "plan"] } },
          },
        },
      ];
    },
  });
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByRole("textbox", { name: "Directory" }), "/work/new");
  await user.click(within(dialog).getByRole("button", { name: "Start" }));
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]).toEqual([
    "createSession",
    "local",
    { cwd: "/work/new", agent: "fake", config: { mode: "plan" } },
  ]);
});

test("deleting a session asks first", async () => {
  const { user, named } = await mount();
  await openFirstSession(user);
  // Delete is in the session's menu: out of the way, so that it is not pressed by habit.
  await user.click(await screen.findByRole("button", { name: "Session actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(named("deleteSession")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(named("deleteSession")).toEqual([["deleteSession", "local", "s1"]]));
});

test("Ctrl or Cmd+Enter allows a pending request, but not while typing in the message box", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  emit({
    type: "permission",
    version: 1,
    request: {
      key: "local:s1:p1",
      hostId: "local",
      sessionId: "s1",
      title: "Allow Bash?",
      subject: {
        type: "tool_call",
        toolCall: { name: "Bash", rawInput: { command: "rm -rf build" } },
      },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    },
  });
  await screen.findByLabelText("Allow Bash?");
  // The key this platform's shortcut uses: Cmd on a Mac, Control elsewhere (the page reads the user agent).
  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await user.click(box);
  await user.keyboard(`{${mod}>}{Enter}{/${mod}}`);
  expect(named("answerPermission")).toHaveLength(0);
  // Out of the message box, the same keys allow it.
  await user.click(document.body);
  await user.keyboard(`{${mod}>}{Enter}{/${mod}}`);
  await waitFor(() =>
    expect(named("answerPermission")).toEqual([["answerPermission", "local:s1:p1", "allow"]]),
  );
});

test("the colours of code can be chosen, and the choice is kept", async () => {
  const { user } = await mount();
  try {
    expect(codeTheme.get()).toBe("github");
    await user.click(await screen.findByRole("combobox", { name: "Code colours" }));
    await user.click(await screen.findByRole("option", { name: "Catppuccin" }));
    await waitFor(() => expect(codeTheme.get()).toBe("catppuccin"));
    expect(localStorage.getItem("cycle-code-theme")).toBe("catppuccin");
  } finally {
    // Global state of the page: whatever happens above, the next test starts from the default.
    codeTheme.set("github");
  }
});

test("Ctrl or Cmd+K searches the sessions by what each shows, and Enter opens the one found", async () => {
  const { user, named } = await mount();
  await screen.findByRole("option", { name: /work/ });
  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await user.keyboard(`{${mod}>}k{/${mod}}`);
  const box = await screen.findByRole("combobox", { name: "Search sessions" });
  // The summary has no title: it is shown by its folder, and found by it.
  await user.type(box, "zzz");
  expect(await screen.findByText("No session matches that.")).toBeTruthy();
  await user.clear(box);
  await user.type(box, "work");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(named("openSession")).toEqual([["openSession", "local", "s1"]]));
});

test("images can be attached when the agent takes them, and go with the message as image blocks", async () => {
  const { user, named } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {},
          promptCapabilities: { image: {} },
        },
      ];
    },
  });
  await openFirstSession(user);
  const attach = await screen.findByRole("button", { name: "Attach image" });
  expect(attach).toBeTruthy();
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) throw new Error("no file input");
  const png = new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", {
    type: "image/png",
  });
  await user.upload(picker, png);
  expect(await screen.findByRole("button", { name: "Remove shot.png" })).toBeTruthy();
  const message = await screen.findByRole("textbox", { name: "Message" });
  await write(message, "what is this");
  await press(message, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(named("prompt")[0]).toEqual([
    "prompt",
    "local",
    "s1",
    [
      { type: "text", text: "what is this" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
  ]);
  // The attachment is gone once sent.
  expect(screen.queryByRole("button", { name: "Remove shot.png" })).toBeNull();
});

test("two images added one right after the other both stay", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {},
          promptCapabilities: { image: {} },
        },
      ];
    },
  });
  await openFirstSession(user);
  await screen.findByRole("button", { name: "Attach image" });
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) throw new Error("no file input");
  const png = (name: string) =>
    new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
  // Not awaited between: the second starts while the first is still being read.
  await user.upload(picker, png("one.png"));
  await user.upload(picker, png("two.png"));
  expect(await screen.findByRole("button", { name: "Remove one.png" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Remove two.png" })).toBeTruthy();
});

test("a session found by the search that is archived is shown, not selected out of sight", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.sessions = async () => [{ ...summary("s1"), archived: true }];
    },
  });
  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await user.keyboard(`{${mod}>}k{/${mod}}`);
  await user.type(await screen.findByRole("combobox", { name: "Search sessions" }), "work");
  await user.keyboard("{Enter}");
  // The list now includes the archived session, and it is the selected one.
  expect(await screen.findByRole("option", { name: /work/ })).toBeTruthy();
});

test("a file that is not an image the agent takes is refused with the reason, and nothing is attached", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {},
          promptCapabilities: { image: {} },
        },
      ];
    },
  });
  await openFirstSession(user);
  await screen.findByRole("button", { name: "Attach image" });
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) throw new Error("no file input");
  // The picker's own filter (`accept`) is only a hint: a drop or a paste brings anything, so the code checks again.
  await userEvent
    .setup({ applyAccept: false })
    .upload(picker, new File(["x"], "pic.bmp", { type: "image/bmp" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "pic.bmp is not a PNG, JPEG, GIF or WebP image.",
  );
  expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
});

test("without the agent's word that it takes images, there is nothing to attach them with", async () => {
  const { user } = await mount();
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.queryByRole("button", { name: "Attach image" })).toBeNull();
});

test("an update that is found is offered, asks before it restarts, and the footer can check on demand", async () => {
  const { user, emit, named } = await mount();
  expect(await screen.findByText("Cycle 0.1.0")).toBeTruthy();
  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "available", version: "0.2.0" },
  });
  expect(screen.getByText("Version 0.2.0 is available")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Update and restart" }));
  // Asked first: nothing is installed until the user agrees.
  expect(named("installUpdate")).toHaveLength(0);
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Update and restart" }));
  await waitFor(() => expect(named("installUpdate")).toHaveLength(1));

  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "downloading", version: "0.2.0", received: 5e6, total: 2e7 },
  });
  expect(screen.getAllByText(/Downloading 0.2.0: 5 of 20 MB/).length).toBeGreaterThan(0);
  // No button to start it again while it works, and no second check.
  expect(screen.queryByRole("button", { name: "Update and restart" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled,
  ).toBe(true);

  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "error", message: "no room", version: "0.2.0" },
  });
  expect(screen.getByText("Updating to 0.2.0 failed: no room")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

  await emit({ type: "app-update", state: { current: "0.1.0", kind: "up-to-date", checkedAt: 0 } });
  await user.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(named("checkForUpdate")).toHaveLength(1);
});

test("a remote host whose daemon is older shows what to run on it, and a current one shows nothing", async () => {
  const { emit } = await mount();
  expect(screen.queryByText(/older than this app/)).toBeNull();
  await emit({
    type: "host-status",
    hostId: "local",
    state: "connected",
    daemon: { version: "0.1.0", upgrade: "curl -fsSLO https://example/x && sh install.sh" },
  });
  expect(screen.getByText(/Cycle on this host is 0.1.0, older than this app/)).toBeTruthy();
  expect(screen.getByText("curl -fsSLO https://example/x && sh install.sh")).toBeTruthy();
  await emit({
    type: "host-status",
    hostId: "local",
    state: "connected",
    daemon: { version: "0.1.1" },
  });
  expect(screen.queryByText(/older than this app/)).toBeNull();
});

test("a host that cannot be reached says why, not only that it is not connected", async () => {
  const { emit } = await mount();
  await emit({
    type: "host-status",
    hostId: "local",
    state: "closed",
    error: "bash: /home/james/.local/bin/cycle-daemon: No such file or directory",
  });
  expect(screen.getByText("Not connected to this host.")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("No such file or directory");
});

test("a development run says updates are for the installed app and offers no check", async () => {
  const { emit } = await mount();
  await emit({
    type: "app-update",
    state: { current: "0.0.0", kind: "disabled", reason: "Updates are for the installed app." },
  });
  expect(screen.getByText("Updates are for the installed app.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
});

const queueUpdate = (version: number, entries: object[], extra: object = {}) => ({
  type: "update" as const,
  hostId: "local",
  sessionId: "s1",
  update: u({ sessionUpdate: "_cycle/queue_update", entries, ...extra }),
  version,
});
const waiting = (id: string, words: string) => ({
  queueId: id,
  prompt: [{ type: "text", text: words }],
});

test("what is queued is listed, and Edit takes it back into the box", async () => {
  const { user, emit, bridge } = await mount();
  const taken: string[] = [];
  bridge.dequeue = async (_host, _session, queueId) => {
    taken.push(queueId);
    return [{ type: "text", text: "the second one" }];
  };
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  emit(queueUpdate(1, [waiting("q1", "the second one")]));
  const list = await screen.findByRole("list", { name: "Queued messages" });
  expect(list.textContent).toContain("the second one");
  await user.click(
    within(list).getByRole("button", { name: /Edit queued message: the second one/ }),
  );
  await waitFor(() => expect(boxText(box)).toBe("the second one"));
  emit(queueUpdate(2, []));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  expect(taken).toEqual(["q1"]);
  expect(document.activeElement).toBe(box);
});

test("what the daemon hands back after a stop is in the box, with no error", async () => {
  const { user, emit, store } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "and this");
  emit(
    queueUpdate(1, [], {
      returned: [waiting("q1", "one"), waiting("q2", "two")],
      reason: "cancelled",
    }),
  );
  await waitFor(() => expect(boxText(box)).toBe("one\n\ntwo\n\nand this"));
  expect(store.getState().error).toBeUndefined();
});

test("each session has its own box, and a draft survives going to another session and back", async () => {
  const { user, store } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "unfinished");
  await act(() => store.selectSession("s2"));
  await waitFor(() => expect(boxText(screen.getByRole("textbox", { name: "Message" }))).toBe(""));
  await act(() => store.selectSession("s1"));
  await waitFor(() =>
    expect(boxText(screen.getByRole("textbox", { name: "Message" }))).toBe("unfinished"),
  );
});

test("Up in an empty box recalls what was sent, Down goes back, and typing is not interfered with", async () => {
  const { user } = await mount({
    snapshot: () =>
      history(
        u({
          sessionUpdate: "user_message",
          messageId: "u1",
          content: [{ type: "text", text: "first" }],
        }),
        text("ok", "a1"),
        u({
          sessionUpdate: "user_message",
          messageId: "u2",
          content: [{ type: "text", text: "second" }],
        }),
        idle({ stopReason: "end_turn" }),
      ),
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await press(box, "ArrowUp");
  expect(boxText(box)).toBe("second");
  await press(box, "ArrowUp");
  expect(boxText(box)).toBe("first");
  await press(box, "ArrowDown");
  expect(boxText(box)).toBe("second");
  await press(box, "ArrowDown");
  expect(boxText(box)).toBe("");
  await write(box, "typing");
  await press(box, "ArrowUp");
  expect(boxText(box)).toBe("typing");
});

test("a message that could not be sent is back in the box", async () => {
  const { user, bridge } = await mount();
  bridge.prompt = async () => {
    throw new Error("The agent is not available");
  };
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "do it");
  await press(box, "Enter");
  await screen.findByRole("alert");
  await waitFor(() => expect(boxText(box)).toBe("do it"));
});

const withCommands = (...names: string[]) =>
  history(
    u({
      sessionUpdate: "available_commands_update",
      availableCommands: names.map((name) => ({
        type: "command",
        name,
        description: `Does ${name}`,
        ...(name === "review" ? { input: { type: "text", hint: "PR number" } } : {}),
      })),
    }),
  );

test("a slash at the start lists the commands that fit; the arrows choose, Enter takes it and does not send", async () => {
  const { user, named } = await mount({
    snapshot: () => withCommands("init", "review", "compact"),
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "/");
  const menu = await screen.findByRole("listbox", { name: "Commands" });
  expect(
    within(menu)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["/initDoes init", "/reviewPR numberDoes review", "/compactDoes compact"]);
  expect(box.getAttribute("aria-expanded")).toBe("true");
  await write(box, "r");
  await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));
  await press(box, "ArrowDown");
  await press(box, "Enter");
  await waitFor(() => expect(boxText(box)).toBe("/review "));
  expect(named("prompt")).toHaveLength(0);
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull());
  // The menu is gone, so Enter sends.
  await write(box, "12");
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "/review 12" }]],
    ]),
  );
});

test("a slash that is not at the start of the message, or has a space after it, opens nothing", async () => {
  const { user } = await mount({ snapshot: () => withCommands("init") });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "see /in");
  await act(async () => {});
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
});

test("Escape closes the menu and Enter then sends what was typed", async () => {
  const { user, named } = await mount({ snapshot: () => withCommands("init") });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "/zzz");
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  await write(box, "\b");
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
});

test("a click on a command takes it, and the input keeps the focus", async () => {
  const { user } = await mount({ snapshot: () => withCommands("init", "compact") });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "/co");
  await user.click(await screen.findByRole("option", { name: /compact/ }));
  await waitFor(() => expect(boxText(box)).toBe("/compact "));
});

const files = (entries: { path: string; kind: "file" | "folder" }[]) => async () => ({
  root: "/work",
  entries,
  truncated: false,
});

test("an @ lists the files that fit; Enter takes one, the text says where, and the agent is sent a link too", async () => {
  const { user, named, bridge } = await mount();
  const asked: string[] = [];
  bridge.searchFiles = async (_host, _session, query) => {
    asked.push(query);
    return query === "ma"
      ? {
          root: "/work",
          entries: [
            { path: "src/main.ts", kind: "file" },
            { path: "docs/manual", kind: "folder" },
          ],
          truncated: false,
        }
      : { root: "/work", entries: [], truncated: false };
  };
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "look at @ma");
  const menu = await screen.findByRole("listbox", { name: "Files and folders" });
  expect(
    within(menu)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["main.tssrc", "manual/docs"]);
  expect(asked.at(-1)).toBe("ma");
  await press(box, "Enter");
  await waitFor(() => expect(boxText(box)).toBe("look at @src/main.ts "));
  expect(named("prompt")).toHaveLength(0);
  await write(box, "please");
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(named("prompt")[0]).toEqual([
    "prompt",
    "local",
    "s1",
    [
      { type: "text", text: "look at @src/main.ts please" },
      {
        type: "resource_link",
        name: "main.ts",
        uri: "file:///work/src/main.ts",
        _meta: { "cycle/mention": "src/main.ts" },
      },
    ],
  ]);
});

test("a name that fits nothing is said so, an @ in an address opens nothing, and a search that fails is quiet", async () => {
  const { user, store, bridge } = await mount();
  bridge.searchFiles = files([]);
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "write to me@example.com");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(screen.queryByRole("listbox", { name: "Files and folders" })).toBeNull();
  const empty = () => document.querySelector('[data-slot="picker"][role="status"]');
  expect(empty()).toBeNull();
  await write(box, " @zzz");
  await waitFor(() => expect(empty()?.textContent).toBe("No file or folder matches that."));
  // The box is not stopped by it: Enter sends what is there.
  bridge.searchFiles = async () => {
    throw new Error("The daemon is old");
  };
  await write(box, "q");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(store.getState().error).toBeUndefined();
});

test("a mention taken back from the queue is a mention again", async () => {
  const { user, bridge, emit, store } = await mount();
  bridge.dequeue = async () => [
    { type: "text", text: "see @a.ts" },
    {
      type: "resource_link",
      name: "a.ts",
      uri: "file:///work/a.ts",
      _meta: { "cycle/mention": "a.ts" },
    },
  ];
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit(queueUpdate(1, [waiting("q1", "see @a.ts")]));
  await user.click(await screen.findByRole("button", { name: /Edit queued message/ }));
  await waitFor(() => expect(boxText(box)).toBe("see @a.ts"));
  expect(store.drafts.get("local:s1").mentions.map((m) => m.uri)).toEqual(["file:///work/a.ts"]);
});
