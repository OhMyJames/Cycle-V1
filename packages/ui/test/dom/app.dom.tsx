import { afterEach, expect, test } from "bun:test";
import type { SessionUpdate } from "@cycle/acp";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PermissionRequest, SessionSnapshot } from "../../src/api.ts";
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
  const note = await screen.findByText(/Reconnecting/);
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
  await user.click(await screen.findByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(named("deleteSession")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(named("deleteSession")).toEqual([["deleteSession", "local", "s1"]]));
});
