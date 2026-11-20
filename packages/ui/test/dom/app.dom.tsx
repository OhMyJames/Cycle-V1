import { afterEach, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PermissionRequest, SessionSnapshot } from "../../src/api.ts";
import { codeTheme } from "../../src/code-theme.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, idle, summary, text } from "../fake-bridge.ts";
import { boxText, press, ready, write } from "./box.ts";

afterEach(() => {
  cleanup();
  // Drafts are kept in the page's storage; each test starts with none.
  localStorage.clear();
});

const u = (update: object) => update as SessionUpdate;

const mount = async (
  options: {
    snapshot?: () => SessionSnapshot;
    configure?: (script: ReturnType<typeof fakeBridge>) => void;
    capabilities?: { queue: boolean; steer?: boolean; files: boolean; folders: boolean };
    steer?: boolean;
  } = {},
) => {
  const script = fakeBridge({
    connected: true,
    ...(options.steer === true ? { steer: true } : {}),
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
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
    environmentId: "local",
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
    environmentId: "local",
    sessionId: "s1",
    update: idle({ stopReason: "cancelled" }),
    version: 2,
  });
  await screen.findByRole("button", { name: "Send" });
});

test("while the agent works, Enter sends into its turn, Shift+Enter queues, and Alt+Enter is a new line", async () => {
  const { user, emit, named } = await mount({
    steer: true,
    capabilities: { queue: true, steer: true, files: true, folders: true },
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    update: u({ sessionUpdate: "state_update", state: "running" }),
    version: 1,
  });
  await screen.findByRole("button", { name: "Send now" });
  expect(screen.getByRole("button", { name: "Queue" })).toBeDefined();
  await write(box, "one");
  await press(box, "Enter", { altKey: true });
  await write(box, "two");
  expect(boxText(box)).toBe("one\ntwo");
  expect(named("prompt")).toHaveLength(0);
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "one\ntwo" }], { steer: true }],
    ]),
  );
  await write(box, "later");
  await press(box, "Enter", { shiftKey: true });
  await waitFor(() => expect(named("prompt")).toHaveLength(2));
  expect(named("prompt")[1]).toEqual(["prompt", "local", "s1", [{ type: "text", text: "later" }]]);
  expect(boxText(box)).toBe("");
});

test("an agent that cannot be steered keeps Enter as queue while it works", async () => {
  const { user, emit, named } = await mount({
    capabilities: { queue: true, steer: true, files: true, folders: true },
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    update: u({ sessionUpdate: "state_update", state: "running" }),
    version: 1,
  });
  await screen.findByRole("button", { name: "Queue" });
  expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  await write(box, "next");
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([["prompt", "local", "s1", [{ type: "text", text: "next" }]]]),
  );
});

test("streams: what arrives is added to the message on screen", async () => {
  const { user, emit } = await mount({ snapshot: () => history() });
  await openFirstSession(user);
  const log = await screen.findByRole("log", { name: "Conversation" });
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    update: text("Hel", "a1"),
    version: 1,
  });
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    update: text("lo!", "a1"),
    version: 2,
  });
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
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  const request: PermissionRequest = {
    key: "local:s1:p1",
    environmentId: "local",
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
  const log = screen.getByRole("log", { name: "Conversation" });
  expect(within(log).getByText("Waiting for your answer")).toBeDefined();
  expect(box.getAttribute("aria-placeholder")).toBe("Waiting for your answer");
  const deny = within(card).getByText<HTMLButtonElement>("Deny");
  emit({ type: "environment-status", environmentId: "local", state: "reconnecting" });
  await waitFor(() => expect(deny.disabled).toBe(true));
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "connected",
    capabilities: { queue: true, files: false, folders: true },
  });
  await waitFor(() => expect(deny.disabled).toBe(false));
  await write(box, "next message");
  const queue = screen.getByRole<HTMLButtonElement>("button", { name: "Queue" });
  expect(queue.disabled).toBe(false);
  await user.click(queue);
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "next message" }]],
    ]),
  );
  await user.click(deny);
  expect(named("answerPermission")).toEqual([["answerPermission", "local:s1:p1", "deny"]]);
  emit({
    type: "permission-closed",
    environmentId: "local",
    sessionId: "s1",
    key: request.key,
    version: 2,
  });
  await waitFor(() => expect(screen.queryByLabelText("Allow Bash?")).toBeNull());
  expect(within(log).queryByText("Waiting for your answer")).toBeNull();
});

test("an agent's questions are a form: a choice, several choices, an answer of one's own; only what was filled goes back", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  await ready(await screen.findByRole("textbox", { name: "Message" }));
  const request: PermissionRequest = {
    key: "local:s1:f1",
    environmentId: "local",
    sessionId: "s1",
    title: "Claude has some questions",
    options: [],
    form: {
      message: "Claude has some questions",
      schema: {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "Library",
            description: "Which library should we use?",
            oneOf: [
              { const: "zod", title: "zod", description: "Already a dependency" },
              { const: "valibot", title: "valibot" },
            ],
          },
          q0_other: {
            type: "string",
            title: "Other",
            description: "Your own answer",
            maxLength: 2000,
          },
          q1: {
            type: "array",
            title: "Targets",
            description: "Which platforms?",
            items: {
              anyOf: [
                { const: "mac", title: "macOS" },
                { const: "linux", title: "Linux" },
              ],
            },
          },
          q1_other: {
            type: "string",
            title: "Other",
            description: "Your own answer",
            maxLength: 2000,
          },
        },
      },
    },
  };
  emit({ type: "permission", request, version: 1 });
  const card = await screen.findByLabelText("Claude has some questions");
  expect(card.textContent).toContain("Which library should we use?");
  expect(card.textContent).toContain("Already a dependency");
  await user.click(within(card).getByRole("radio", { name: /zod/ }));
  await user.click(within(card).getByRole("checkbox", { name: /macOS/ }));
  await user.click(within(card).getByRole("checkbox", { name: /Linux/ }));
  await user.click(within(card).getByRole("checkbox", { name: /macOS/ }));
  const [, second] = within(card).getAllByPlaceholderText("Your own answer");
  await user.type(second as HTMLElement, "FreeBSD");
  await user.click(within(card).getByText("Send answers"));
  expect(named("answerForm")).toEqual([
    [
      "answerForm",
      "local:s1:f1",
      { action: "accept", content: { q0: "zod", q1: ["linux"], q1_other: "FreeBSD" } },
    ],
  ]);
  // Not a permission: it is never answered as one.
  expect(named("answerPermission")).toEqual([]);
  await user.click(within(card).getByText("Skip questions"));
  expect(named("answerForm").at(-1)).toEqual(["answerForm", "local:s1:f1", { action: "decline" }]);
});

test("a form's required field must be filled before it is answered; one the app cannot draw can only be skipped", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  await ready(await screen.findByRole("textbox", { name: "Message" }));
  const form = (key: string, properties: object, required: string[]): PermissionRequest => ({
    key,
    environmentId: "local",
    sessionId: "s1",
    title: key,
    options: [],
    form: { message: key, schema: { type: "object", properties, required } },
  });
  emit({
    type: "permission",
    request: form("Name it", { name: { type: "string", title: "Name" } }, ["name"]),
    version: 1,
  });
  const card = await screen.findByLabelText("Name it");
  const answer = within(card)
    .getByText<HTMLButtonElement>("Send answers")
    .closest("button") as HTMLButtonElement;
  expect(card.textContent).toContain("required");
  expect(answer.disabled).toBe(true);
  await user.type(within(card).getByRole("textbox"), "cycle");
  await waitFor(() => expect(answer.disabled).toBe(false));
  await user.click(answer);
  expect(named("answerForm")).toEqual([
    ["answerForm", "Name it", { action: "accept", content: { name: "cycle" } }],
  ]);
  emit({
    type: "permission",
    request: form("Odd", { where: { type: "object", title: "Where" } }, ["where"]),
    version: 2,
  });
  const odd = await screen.findByLabelText("Odd");
  expect(odd.textContent).toContain("can't show");
  expect(
    (within(odd).getByText("Send answers").closest("button") as HTMLButtonElement).disabled,
  ).toBe(true);
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
  emit({ type: "environment-status", environmentId: "local", state: "reconnecting" });
  const note = await screen.findByText(/Connection lost/);
  expect(note.getAttribute("role") ?? note.parentElement?.getAttribute("role")).toBe("status");
});

test("an open session keeps its draft offline and can send it after reconnecting", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Keep this");
  await emit({ type: "environment-status", environmentId: "local", state: "reconnecting" });
  await screen.findByText("Connection lost. You can keep editing your draft.");
  await ready(box);
  await write(box, " draft");
  await press(box, "Enter");
  expect(boxText(box)).toBe("Keep this draft");
  expect(named("prompt")).toHaveLength(0);
  await emit({ type: "environment-status", environmentId: "local", state: "connected" });
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "Keep this draft" }]],
    ]),
  );
});

test("a new session is a blank conversation: nothing is made until its first message, which starts it from the agent's defaults in the folder typed", async () => {
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
  expect(await screen.findByRole("heading", { name: "New session" })).toBeTruthy();
  expect(screen.getByText("The session starts when you send the first message.")).toBeTruthy();
  // It starts from the folder of the workspace that is shown: the person replaces it.
  const where = screen.getByRole("group", { name: "Where the session runs" });
  const folder = within(where).getByRole("textbox", { name: "Folder" });
  expect((folder as HTMLInputElement).value).toBe("/work");
  await user.clear(folder);
  // No folder: the box takes words, and says why they cannot go yet.
  expect(await screen.findByText("Choose a folder for the agent to work in.")).toBeTruthy();
  await user.type(folder, "/work/new");
  // What it starts with is shown under the box, before anything is made.
  await screen.findByRole("button", { name: "mode: plan" });
  expect(named("createSession")).toEqual([]);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Fix the build");
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(named("createSession")[0]).toEqual([
    "createSession",
    "local",
    { cwd: "/work/new", agent: "fake", config: { mode: "plan" } },
  ]);
  expect(named("prompt")[0]).toEqual([
    "prompt",
    "local",
    "s2",
    [{ type: "text", text: "Fix the build" }],
  ]);
  // The session is open in its place.
  await waitFor(() =>
    expect(screen.queryByRole("group", { name: "Where the session runs" })).toBeNull(),
  );
});

test("a choice the agent names and describes shows its name and what it does, and sends its value", async () => {
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
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [
                  {
                    const: "auto",
                    title: "Auto",
                    description: "Decides for you.",
                    _meta: { "cycle/recommended": true },
                  },
                  { const: "default", title: "Ask before acting", description: "Asks first." },
                  { const: "plan", title: "Plan mode", description: "Changes nothing." },
                ],
              },
            },
          },
        },
      ];
    },
  });
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const chip = await screen.findByRole("button", { name: "Permission mode: Plan mode" });
  await user.click(chip);
  const option = await screen.findByRole("menuitemradio", { name: /Ask before acting/ });
  expect(option.textContent).toContain("Asks first.");
  // The suggested one says so; the others do not.
  expect(option.textContent).not.toContain("Recommended");
  expect(screen.getByRole("menuitemradio", { name: /Auto/ }).textContent).toContain("Recommended");
  expect(screen.getByRole("menuitemradio", { name: /Plan mode/ }).textContent).toContain(
    "Changes nothing.",
  );
  await user.click(option);
  // The choice is what the box shows under it, too.
  await screen.findByRole("button", { name: "Permission mode: Ask before acting" });
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "hi");
  await press(box, "Enter");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]?.[2]).toMatchObject({ config: { mode: "default" } });
});

test("session settings show an unknown mode and follow the daemon while the dialog stays open", async () => {
  const { user, emit, named } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [
                  { const: "auto", title: "Auto" },
                  { const: "default", title: "Ask before acting" },
                ],
                default: "auto",
              },
            },
          },
        },
      ];
    },
  });
  await openFirstSession(user);
  // Session settings lives in the session header menu, not beside permission in the composer.
  await user.click(await screen.findByRole("button", { name: "Session actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Session settings" }));
  const dialog = await screen.findByRole("dialog");
  const trigger = within(dialog).getByRole("combobox", { name: "Permission mode" });
  // An older session may run in another mode than new ones start in: say nothing rather than guess.
  expect(trigger.textContent).toContain("Not set");
  expect(trigger.textContent).not.toContain("Auto");
  emit({
    type: "sessions",
    environmentId: "local",
    sessions: [{ ...summary("s1"), config: { mode: "default" } }],
  });
  expect(trigger.textContent).toContain("Ask before acting");
  expect(named("setSessionConfig")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(
    await screen.findByRole("button", { name: "Permission mode: Ask before acting" }),
  ).toBeTruthy();
});

test("a setting the schema does not list is shown as it is, not as Not set", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.sessions = async () => [
        { ...summary("s1"), config: { model: "claude-opus-4-5" } },
      ];
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: {
              model: { type: "string", title: "Model", oneOf: [{ const: "opus", title: "Opus" }] },
            },
          },
        },
      ];
    },
  });
  await openFirstSession(user);
  await screen.findByRole("button", { name: "Model: claude-opus-4-5" });
  // No settings gear button beside permission in the composer utility bar.
  expect(screen.queryByRole("button", { name: "Session settings" })).toBeNull();
});

test("an agent with nothing to set has no settings in the message box", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        { id: "fake", name: "Fake", available: true, configSchema: { type: "object" } },
      ];
    },
  });
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.queryByRole("button", { name: "Session settings" })).toBeNull();
});

test("the session's settings are at hand under the message box, and a choice there is sent", async () => {
  const { user, named } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [
                  { const: "auto", title: "Auto" },
                  { const: "plan", title: "Plan mode", description: "Changes nothing." },
                ],
                default: "auto",
              },
              // Text is not a choice: it stays in Session settings.
              prompt: { type: "string", title: "System prompt" },
            },
          },
        },
      ];
    },
  });
  await openFirstSession(user);
  // Nothing on record: said so, not shown as the default.
  const chip = await screen.findByRole("button", { name: "Permission mode: Not set" });
  expect(screen.queryByRole("button", { name: /System prompt/ })).toBeNull();
  await user.click(chip);
  await user.click(await screen.findByRole("menuitemradio", { name: /Plan mode/ }));
  await waitFor(() =>
    expect(named("setSessionConfig")).toEqual([
      ["setSessionConfig", "local", "s1", "mode", "plan"],
    ]),
  );
});

test("the session menu marks only the displayed unknown background tasks as ended", async () => {
  const { user, named } = await mount({
    configure: ({ bridge }) => {
      bridge.sessions = async () => [{ ...summary("s1"), unknownBackground: ["child"] }];
    },
  });
  await openFirstSession(user);
  await user.click(await screen.findByRole("button", { name: "Session actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Mark 1 unconfirmed background task as ended" }),
  );
  await waitFor(() =>
    expect(named("dismissBackground")).toEqual([["dismissBackground", "local", "s1", ["child"]]]),
  );
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

test("Ctrl or Cmd+Enter allows a pending request even while typing in the message box, when connected", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  emit({
    type: "permission",
    version: 1,
    request: {
      key: "local:s1:p1",
      environmentId: "local",
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
  await write(box, "half-written follow-up");
  await user.click(box);
  emit({ type: "environment-status", environmentId: "local", state: "reconnecting" });
  await user.keyboard(`{${mod}>}{Enter}{/${mod}}`);
  expect(named("answerPermission")).toHaveLength(0);
  emit({ type: "environment-status", environmentId: "local", state: "connected" });
  // Connected, Cmd/Ctrl+Enter allows it even with focus and a draft inside the message box, without sending or adding a line break.
  await user.keyboard(`{${mod}>}{Enter}{/${mod}}`);
  await waitFor(() =>
    expect(named("answerPermission")).toEqual([["answerPermission", "local:s1:p1", "allow"]]),
  );
  expect(named("sendPrompt")).toHaveLength(0);
  expect(boxText(box)).toBe("half-written follow-up");
});

test("the colours of code can be chosen, and the choice is kept", async () => {
  const { user } = await mount();
  try {
    expect(codeTheme.get()).toBe("github");
    await user.click(await screen.findByRole("button", { name: "App settings" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Catppuccin" }));
    await waitFor(() => expect(codeTheme.get()).toBe("catppuccin"));
    expect(localStorage.getItem("cycle-code-theme")).toBe("catppuccin");
  } finally {
    // Global state of the page: whatever happens above, the next test starts from the default.
    codeTheme.set("github");
  }
});

test("Ctrl or Cmd+K searches the sessions by what each shows, and Enter opens the one found", async () => {
  const { user, named } = await mount({
    configure: (script) => {
      script.bridge.sessions = async () => [{ ...summary("s1"), state: "requires_action" }];
    },
  });
  await screen.findByRole("option", { name: /work/ });
  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await user.keyboard(`{${mod}>}k{/${mod}}`);
  const box = await screen.findByRole("combobox", { name: "Search sessions" });
  // The summary has no title: it is shown by its folder, and found by it.
  await user.type(box, "zzz");
  expect(await screen.findByText("No session matches that.")).toBeTruthy();
  await user.clear(box);
  await user.type(box, "work");
  expect(await screen.findByRole("option", { name: /work.*Needs you/ })).toBeDefined();
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
  // By the difference it says so, and how much it is: the changes, not the app.
  await emit({
    type: "app-update",
    state: {
      current: "0.1.0",
      kind: "downloading",
      version: "0.2.0",
      received: 5e6,
      total: 4e7,
      how: "difference",
    },
  });
  expect(
    screen.getAllByText(/Downloading the changes for 0.2.0: 5 of 40 MB/).length,
  ).toBeGreaterThan(0);
  // No button to start it again while it works, and no second check.
  expect(screen.queryByRole("button", { name: "Update and restart" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "App settings" }));
  expect(
    (await screen.findByRole("menuitem", { name: "Check for updates" })).getAttribute(
      "aria-disabled",
    ),
  ).toBe("true");
  await user.keyboard("{Escape}");

  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "error", message: "no room", version: "0.2.0" },
  });
  expect(screen.getByText("Updating to 0.2.0 failed: no room")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

  await emit({ type: "app-update", state: { current: "0.1.0", kind: "up-to-date", checkedAt: 0 } });
  await user.click(screen.getByRole("button", { name: "App settings" }));
  await user.click(await screen.findByRole("menuitem", { name: "Check for updates" }));
  expect(named("checkForUpdate")).toHaveLength(1);
});

test("a daemon too old for the app says so in one line with a button, and updating asks first", async () => {
  const { emit, user, named } = await mount();
  expect(screen.queryByText(/too old for this app/)).toBeNull();
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "connected",
    daemon: { version: "0.1.0", upgrade: { to: "0.3.0", command: "sh install.sh" } },
  });
  expect(screen.getByText(/Cycle on .* is 0\.1\.0, too old for this app/)).toBeTruthy();
  // The command is not the first thing shown.
  expect(screen.queryByText("sh install.sh")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Update to 0.3.0" }));
  expect(named("upgradeDaemon")).toHaveLength(0);
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Update" }));
  await waitFor(() => expect(named("upgradeDaemon")).toEqual([["upgradeDaemon", "local"]]));
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "connected",
    daemon: { version: "0.3.0" },
  });
  expect(screen.queryByText(/too old for this app/)).toBeNull();
});

test("updating a daemon whose sessions are working names them, and the person waits for them or interrupts them", async () => {
  const { emit, user, named } = await mount();
  await emit({
    type: "sessions",
    environmentId: "local",
    sessions: [
      { ...summary("s1"), title: "Fix the build", state: "running" },
      { ...summary("s2"), title: "Idle one", state: "idle" },
    ],
  });
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "connected",
    daemon: { version: "0.1.0", upgrade: { to: "0.3.0", command: "sh install.sh" } },
  });
  await user.click(screen.getByRole("button", { name: "Update to 0.3.0" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/Fix the build/)).toBeTruthy();
  expect(within(dialog).queryByText(/Idle one/)).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Update when they finish" }));
  await waitFor(() =>
    expect(named("upgradeDaemon")).toEqual([["upgradeDaemon", "local", "later"]]),
  );

  // Installed and waiting: the line says so, and what is left to choose is to interrupt them.
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "connected",
    daemon: {
      version: "0.1.0",
      upgrade: { to: "0.3.0", command: "sh install.sh", waiting: true },
    },
  });
  expect(screen.getByText(/restarts as the new version when its sessions finish/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Update now" }));
  const again = await screen.findByRole("alertdialog");
  expect(within(again).queryByRole("button", { name: "Update when they finish" })).toBeNull();
  await user.click(within(again).getByRole("button", { name: "Update now and interrupt" }));
  await waitFor(() =>
    expect(named("upgradeDaemon").at(-1)).toEqual(["upgradeDaemon", "local", "now"]),
  );
});

test("a daemon on another protocol says why it cannot be used and what to update, and the line goes when it connects", async () => {
  const { emit } = await mount();
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "reconnecting",
    error: "The daemon speaks Cycle protocol 0.2; this client speaks 1.0.",
    incompatible: {
      with: "daemon",
      supported: ["0.2"],
      requested: "1.0",
      command: "sh install.sh",
    },
  });
  expect(screen.getByText(/speaks protocol 0\.2, older than the 1\.0 this app needs/)).toBeTruthy();
  // Not stacked with the generic "Connection lost" banner: protocol mismatch is the single reason.
  expect(screen.queryByText(/Connection lost/)).toBeNull();
  // Not a button that would act on a daemon that is not connected: the command, to run on that machine.
  expect(screen.getByText("sh install.sh")).toBeTruthy();

  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "reconnecting",
    error: "x",
    incompatible: { with: "app", supported: ["2.0"], requested: "1.0" },
  });
  // The app is the one to update: the daemon is not offered a downgrade.
  expect(screen.getByText(/newer than the 1\.0 this app has\. Update this app/)).toBeTruthy();
  expect(screen.queryByText("sh install.sh")).toBeNull();

  await emit({ type: "environment-status", environmentId: "local", state: "connected" });
  expect(screen.queryByText(/this app needs|this app has|cannot use/)).toBeNull();
});

test("a daemon update that did not work says why and shows the command to run by hand", async () => {
  const { emit } = await mount();
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "connected",
    daemon: {
      version: "0.1.0",
      upgrade: { to: "0.3.0", command: "sh install.sh", error: "Permission denied (publickey)." },
    },
  });
  expect(
    screen.getByText(/Could not update Cycle on .*Permission denied \(publickey\)\./),
  ).toBeTruthy();
  expect(screen.getByText("sh install.sh")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("a host that cannot be reached says why, not only that it is not connected", async () => {
  const { emit } = await mount();
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "closed",
    error: "bash: /home/james/.local/bin/cycle-daemon: No such file or directory",
  });
  expect(screen.getByText("Not connected to this environment.")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("No such file or directory");
});

test("a development run says updates are for the installed app and offers no check", async () => {
  const { emit, user } = await mount();
  await emit({
    type: "app-update",
    state: { current: "0.0.0", kind: "disabled", reason: "Updates are for the installed app." },
  });
  expect(screen.getByText("Updates are for the installed app.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "App settings" }));
  await screen.findByRole("menuitemradio", { name: "GitHub" });
  expect(screen.queryByRole("menuitem", { name: "Check for updates" })).toBeNull();
});

const queueUpdate = (version: number, entries: object[], extra: object = {}) => ({
  type: "update" as const,
  environmentId: "local",
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
  await act(() => store.selectSession("local", "s2"));
  await waitFor(() => expect(boxText(screen.getByRole("textbox", { name: "Message" }))).toBe(""));
  await act(() => store.selectSession("local", "s1"));
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

test("with the menu open, Shift+Enter is a new line and does not take what is chosen", async () => {
  const { user, named } = await mount({ snapshot: () => withCommands("init", "review") });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "/r");
  await screen.findByRole("listbox", { name: "Commands" });
  await press(box, "Enter", { shiftKey: true });
  await write(box, "x");
  expect(boxText(box)).toBe("/r\nx");
  expect(named("prompt")).toHaveLength(0);
});

test("a command typed in full is sent by Enter, not rewritten", async () => {
  const { user, named } = await mount({ snapshot: () => withCommands("init", "compact") });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "/compact");
  await screen.findByRole("listbox", { name: "Commands" });
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "/compact" }]],
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

test("a PDF taken back from the queue is shown, can be removed, and goes out again with the message", async () => {
  const { user, bridge, emit, named } = await mount();
  const pdf = {
    type: "resource" as const,
    resource: { uri: "file:///work/spec.pdf", mimeType: "application/pdf", blob: "AAAA" },
  };
  bridge.dequeue = async () => [{ type: "text", text: "read it" }, pdf];
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit(queueUpdate(1, [waiting("q1", "read it")]));
  await user.click(await screen.findByRole("button", { name: /Edit queued message/ }));
  await waitFor(() => expect(boxText(box)).toBe("read it"));
  expect(screen.getByRole("button", { name: "Remove spec.pdf" })).toBeTruthy();
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(named("prompt")[0]?.[3]).toEqual([{ type: "text", text: "read it" }, pdf]);
});

test("a daemon that does not queue is not sent a message while the agent works, and says why", async () => {
  const { user, emit, named } = await mount({
    capabilities: { queue: false, files: false, folders: true },
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    update: u({ sessionUpdate: "state_update", state: "running" }),
    version: 1,
  });
  await write(box, "next");
  const send = (await screen.findByRole("button", { name: "Send" })) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  await press(box, "Enter");
  expect(named("prompt")).toHaveLength(0);
  expect(document.querySelector('[data-slot="composer-placeholder"]')).toBeNull();
  expect(box.getAttribute("aria-placeholder")).toBe(
    "The agent is working. Stop it to send a message now.",
  );
  // The text stays: it goes when the turn is over.
  expect(boxText(box)).toBe("next");
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("a daemon that does not find files is not asked for them", async () => {
  const { user, bridge, named } = await mount({
    capabilities: { queue: true, files: false, folders: true },
  });
  bridge.searchFiles = async () => {
    throw new Error("must not be asked");
  };
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "@ma");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(screen.queryByRole("listbox", { name: "Files and folders" })).toBeNull();
  expect(named("searchFiles")).toHaveLength(0);
});

test("while the first message makes the session it is shown, nothing can be changed, and a failure gives it back with the reason", async () => {
  let fail: (error: Error) => void = () => {};
  const { user, named } = await mount({
    configure: (script) => {
      script.bridge.createSession = () =>
        new Promise((_, reject) => {
          fail = reject;
        });
    },
  });
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Fix the build");
  await press(box, "Enter");
  // The message is there, as it will be in the session, and the agent is being started for it.
  expect(await screen.findByText("Fix the build")).toBeTruthy();
  expect(screen.getAllByText("Starting the session…").length).toBeGreaterThan(0);
  const where = screen.getByRole("group", {
    name: "Where the session runs",
  }) as HTMLFieldSetElement;
  expect(where.disabled).toBe(true);
  await act(async () => {
    fail(new Error("No such folder"));
    await Bun.sleep(5);
  });
  expect(await screen.findByText("No such folder")).toBeTruthy();
  await waitFor(() => expect(boxText(box)).toBe("Fix the build"));
  expect(where.disabled).toBe(false);
  expect(named("prompt")).toEqual([]);
});

test("asking for a new session while one is blank keeps it as it is", async () => {
  const { user } = await mount();
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const folder = (await screen.findByRole("textbox", { name: "Folder" })) as HTMLInputElement;
  await user.clear(folder);
  await user.type(folder, "/new/project");
  await user.click(screen.getByRole("button", { name: "New session" }));
  expect((screen.getByRole("textbox", { name: "Folder" }) as HTMLInputElement).value).toBe(
    "/new/project",
  );
});

test("empty state offers Start a new session and high-risk mode chip carries data-danger", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [
                  { const: "auto", title: "Auto", _meta: { "cycle/recommended": true } },
                  {
                    const: "bypassPermissions",
                    title: "Bypass permissions",
                    _meta: { "cycle/danger": true },
                  },
                ],
                default: "bypassPermissions",
              },
            },
          },
        },
      ];
    },
  });
  await user.click(await screen.findByRole("button", { name: "Start a new session" }));
  const chip = await screen.findByRole("button", { name: "Permission mode: Bypass permissions" });
  expect(chip.hasAttribute("data-danger")).toBe(true);
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeTruthy();
});

test("composer uses a single-line box by default, promotes on attachments or multi-action, and docks extensions above", async () => {
  const { user, emit } = await mount({
    configure: (script) => {
      const session = { ...summary("s1"), config: { mode: "auto", model: "opus", effort: "high" } };
      script.bridge.environments = async () => ({
        environments: [{ id: "local", name: "This computer", kind: "local" }],
        status: [
          {
            environmentId: "local",
            state: "connected",
            capabilities: { queue: true, files: false, folders: false },
          },
        ],
        sessions: { local: [session] },
      });
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          promptCapabilities: { image: {} },
          configSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [{ const: "auto", title: "Auto" }],
              },
              model: {
                type: "string",
                title: "Model",
                oneOf: [{ const: "opus", title: "Opus" }],
              },
              effort: {
                type: "string",
                title: "Effort",
                oneOf: [
                  { const: "default", title: "Default" },
                  { const: "high", title: "High" },
                ],
              },
            },
          },
        },
      ];
      script.bridge.sessions = async () => [session];
    },
  });
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });

  // Idle with no extensions or attachments: compact single-line box, no extension tray, no legacy key-hints.
  const composerBox = document.querySelector('[data-slot="composer-box"]');
  expect(composerBox?.hasAttribute("data-multiline")).toBe(false);
  expect(document.querySelector('[data-slot="composer-extensions"]')).toBeNull();
  expect(document.querySelector('[data-slot="key-hints"]')).toBeNull();

  // Utility bar puts permission on the left, model + effort and context ring on the right.
  const toolsStart = document.querySelector<HTMLElement>('[data-slot="composer-tools-start"]');
  const toolsEnd = document.querySelector<HTMLElement>('[data-slot="composer-tools-end"]');
  expect(
    toolsStart && within(toolsStart).getByRole("button", { name: "Permission mode: Auto" }),
  ).toBeTruthy();
  expect(
    toolsEnd && within(toolsEnd).getByRole("button", { name: "Model: Opus, Effort: High" }),
  ).toBeTruthy();

  // Usage shows ring + percentage only; the numbers are in its details.
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    version: 1,
    update: {
      sessionUpdate: "usage_update",
      used: 12_000,
      size: 200_000,
      cost: { amount: 0.88, currency: "USD" },
    } as never,
  });
  const meter = await screen.findByRole("button", { name: "Context 6% full. Show details" });
  expect(meter.textContent).toBe("6%");

  // Plan + queued message dock inside the extension tray above the input box, and multi-action working state promotes to multiline.
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    version: 2,
    update: { sessionUpdate: "state_update", state: "running" } as never,
  });
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    version: 3,
    update: {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "p1",
        entries: [{ content: "Ship three-part composer", priority: "high", status: "in_progress" }],
      },
    } as never,
  });
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    version: 4,
    update: {
      sessionUpdate: "_cycle/queue_update",
      entries: [{ queueId: "q1", prompt: [{ type: "text", text: "Follow up next" }] }],
    } as never,
  });
  await waitFor(() => {
    const ext = document.querySelector('[data-slot="composer-extensions"]');
    expect(ext?.textContent).toContain("Ship three-part composer");
    expect(ext?.textContent).toContain("Follow up next");
    expect(
      document.querySelector('[data-slot="composer-box"]')?.hasAttribute("data-multiline"),
    ).toBe(true);
  });

  // Live config_option_update from the agent overlays newly discovered models and hides effort when unsupported.
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    version: 5,
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          configId: "model",
          name: "Model",
          currentValue: "opus",
          options: [
            { value: "default", name: "Default model" },
            { value: "fabel", name: "Fabel" },
            { value: "opus", name: "Opus" },
          ],
        },
        {
          configId: "effort",
          name: "Effort",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
      ],
    } as never,
  });
  const modelButton = await screen.findByRole("button", { name: "Model: Opus" });
  await user.click(modelButton);
  expect(await screen.findByRole("menuitemradio", { name: "Fabel" })).toBeTruthy();
  // Model with only "default" effort hides the Effort slider.
  expect(screen.queryByRole("slider", { name: "Effort" })).toBeNull();

  // Reaching 100% context marks the ring as full and settles cleanly at offset 0.
  emit({
    type: "update",
    environmentId: "local",
    sessionId: "s1",
    version: 6,
    update: { sessionUpdate: "usage_update", used: 200_000, size: 200_000 } as never,
  });
  const fullMeter = await screen.findByRole("button", { name: /Context 100% full/ });
  expect(fullMeter.hasAttribute("data-full")).toBe(true);
  expect(fullMeter.textContent).toBe("100%");
  const fill = fullMeter.querySelector<SVGCircleElement>('[data-slot="context-fill"]');
  expect(fill?.style.strokeDashoffset).toBe("0");
});

test("the context ring opens into what was reported: nothing yet, now's usage, and one from before a compaction", async () => {
  const { user, emit, calls } = await mount({
    configure: (script) => {
      const session = summary("s1");
      script.bridge.sessions = async () => [session];
    },
  });
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });
  const update = (version: number, u: object) =>
    emit({ type: "update", environmentId: "local", sessionId: "s1", version, update: u as never });
  const tracked = () =>
    calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);

  // Nothing reported yet: an empty ring, and details that say so rather than a number.
  const empty = await screen.findByRole("button", {
    name: "Context usage not reported yet. Show details",
  });
  expect(empty.hasAttribute("data-empty")).toBe(true);
  await user.click(empty);
  const details = await screen.findByRole("dialog", { name: "Context" });
  expect(details.textContent).toContain(
    "No usage yet. The agent reports it when a reply finishes.",
  );
  expect(details.textContent).not.toMatch(/tokens|%/);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Context" })).toBeNull());
  expect(document.activeElement).toBe(empty);

  // Measured: used and window as the agent gave them, the share, and the session's cost.
  update(1, {
    sessionUpdate: "usage_update",
    used: 84_000,
    size: 200_000,
    cost: { amount: 0.52, currency: "USD" },
  });
  const ring = await screen.findByRole("button", { name: "Context 42% full. Show details" });
  await user.click(ring);
  const now = await screen.findByRole("dialog", { name: "Context" });
  expect(now.textContent).toContain("Used84,000 tokens42% full");
  expect(now.textContent).toContain("Window200,000 tokens");
  expect(now.textContent).toContain("Session cost$0.52");
  expect(now.textContent).not.toContain("Compactions");
  expect(now.textContent).not.toContain("before the last compaction");
  await user.click(ring);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Context" })).toBeNull());

  // A compaction completed and no usage came after it: the number is kept, and said to be from before.
  update(2, { sessionUpdate: "compaction_update", compactionId: "k1", status: "in_progress" });
  update(3, { sessionUpdate: "compaction_update", compactionId: "k1", status: "completed" });
  const stale = await screen.findByRole("button", {
    name: "Context was 42% full before the last compaction. Show details",
  });
  expect(stale.hasAttribute("data-before")).toBe(true);
  await user.click(stale);
  const before = await screen.findByRole("dialog", { name: "Context" });
  expect(before.textContent).toContain("Measured before the last compaction.");
  expect(before.textContent).toContain("Compactions1");
  await user.keyboard("{Escape}");

  // The usage after it is now's again.
  update(4, { sessionUpdate: "usage_update", used: 30_000, size: 200_000 });
  await screen.findByRole("button", { name: "Context 15% full. Show details" });

  // Only what kind of state it was is counted; no number goes with it.
  const opened = tracked().filter(([event]) => event === "context_details_opened");
  expect(opened).toEqual([
    ["context_details_opened", { state: "empty" }],
    ["context_details_opened", { state: "measured" }],
    ["context_details_opened", { state: "before_compaction" }],
  ]);
  expect(JSON.stringify(opened)).not.toMatch(/84|200|0\.52/);
});
