import { afterEach, expect, test } from "bun:test";
import type { SessionUpdate } from "@cycle/acp";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PermissionRequest, SessionSnapshot } from "../../src/api.ts";
import { codeTheme } from "../../src/code-theme.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, idle, text } from "../fake-bridge.ts";

afterEach(cleanup);

const u = (update: object) => update as SessionUpdate;

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
  const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
  await waitFor(() => expect(box.disabled).toBe(false));
  await user.type(box, "first line{Shift>}{Enter}{/Shift}second line");
  expect(box.value).toBe("first line\nsecond line");
  expect(named("prompt")).toHaveLength(0);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(named("prompt")).toEqual([["prompt", "local", "s1", "first line\nsecond line"]]),
  );
  expect(box.value).toBe("");
});

test("while the agent works the button stops it, and the box does not send", async () => {
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
  await user.click(stop);
  expect(named("cancel")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
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
  await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
  await user.type(box, "hi{Enter}");
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
  expect(codeTheme.get()).toBe("github");
  await user.click(await screen.findByRole("combobox", { name: "Code colours" }));
  await user.click(await screen.findByRole("option", { name: "Catppuccin" }));
  await waitFor(() => expect(codeTheme.get()).toBe("catppuccin"));
  expect(localStorage.getItem("cycle-code-theme")).toBe("catppuccin");
  codeTheme.set("github");
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
