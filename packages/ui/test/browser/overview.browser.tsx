import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { SessionSnapshot } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, idle, text } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const u = (update: object) => update as SessionUpdate;

const history = (...updates: SessionUpdate[]): SessionSnapshot => ({
  conversation: updates.reduce(applyUpdate, emptyConversation()),
  permissions: [],
  version: updates.length,
});

const busy = history(
  u({ sessionUpdate: "user_message", messageId: "u1", content: [{ type: "text", text: "Go" }] }),
  u({
    sessionUpdate: "plan_update",
    plan: {
      type: "items",
      planId: "tasks",
      entries: [
        { content: "Write the parser", priority: "medium", status: "completed" },
        { content: "Test the parser", priority: "medium", status: "in_progress" },
      ],
    },
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-b",
    title: "Bash",
    kind: "execute",
    status: "completed",
    rawInput: { command: "bun dev", run_in_background: true },
    _meta: { "cycle/tool": "Bash" },
  }),
  u({
    sessionUpdate: "_cycle/task_update",
    taskId: "b1",
    kind: "shell",
    title: "Run the dev server",
    toolCallId: "call-b",
    state: "running",
  }),
  u({ sessionUpdate: "_cycle/task_update", taskId: "old", kind: "monitor", state: "completed" }),
  u({
    sessionUpdate: "_cycle/goal_update",
    goal: { condition: "All tests pass", iterations: 2, setAt: 0, lastReason: "Two still fail" },
  }),
  u({
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        configId: "model",
        name: "Model",
        type: "select",
        currentValue: "opus",
        options: [{ value: "opus", name: "Opus" }],
      },
      {
        configId: "mode",
        name: "Mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "default", name: "Ask" }],
      },
    ],
  }),
  text("Working on it", "a1"),
  idle({ stopReason: "end_turn" }),
);

const mount = async (snapshot: SessionSnapshot) => {
  const script = fakeBridge({ connected: true, snapshot: () => snapshot });
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /work/ }));
  await screen.findByRole("log", { name: "Conversation" });
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  const panel = await screen.findByRole("complementary", { name: "Panel" });
  return { script, user, panel };
};

test("the Overview shows the goal, the todo list, the background, and the session's settings", async () => {
  const { panel } = await mount(busy);
  const overview = within(panel);
  expect(overview.getByRole("heading", { name: "Goal" })).toBeDefined();
  expect(panel.textContent).toContain("All tests pass");
  expect(panel.textContent).toContain("Two still fail");
  expect(panel.textContent).toContain("1 of 2 done");
  expect(panel.textContent).toContain("Test the parser");
  expect(overview.getByRole("button", { name: /Run the dev server/ })).toBeDefined();
  expect(panel.textContent).toContain("1 running");
  expect(panel.textContent).toContain("1 ended");
  expect(panel.textContent).toContain("Scheduled calls (cron, wakeups) are not tracked yet");
  expect(panel.textContent).toContain("Opus");
  // A setting left to the agent is said to be the default, not guessed at.
  expect(panel.textContent).toContain("Default");
  expect(panel.textContent).toContain("/work");
});

test("a background task goes back to the call that started it, and only the section is counted", async () => {
  const { panel, user, script } = await mount(busy);
  await user.click(within(panel).getByRole("button", { name: /Run the dev server/ }));
  await waitFor(() =>
    expect(document.querySelector('[data-item-id="call-b"][data-revealed]')).not.toBeNull(),
  );
  const events = script.calls
    .filter(([name]) => name === "track")
    .map(([, event, props]) => [event, props])
    .filter(([event]) => event === "overview_item_revealed");
  expect(events).toEqual([["overview_item_revealed", { section: "background" }]]);
  expect(JSON.stringify(events)).not.toContain("dev server");
});

test("a session from before these updates says what it has not got, block by block", async () => {
  const { panel } = await mount(history(text("Hello", "a1"), idle({ stopReason: "end_turn" })));
  expect(within(panel).queryByRole("heading", { name: "Goal" })).toBeNull();
  expect(panel.textContent).toContain("No todo list in this session yet");
  expect(panel.textContent).toContain("Nothing running in the background");
  expect(panel.textContent).toContain("No usage reported yet");
});

test("a task started by a call inside a closed card of several calls opens the card to show it", async () => {
  const call = (id: string, command: string) =>
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      title: "Bash",
      kind: "execute",
      status: "completed",
      rawInput: { command },
    });
  const { panel, user } = await mount(
    history(
      u({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [{ type: "text", text: "Go" }],
      }),
      call("c1", "ls"),
      call("c2", "bun dev"),
      u({
        sessionUpdate: "_cycle/task_update",
        taskId: "b2",
        kind: "shell",
        title: "Serve the app",
        toolCallId: "c2",
        state: "running",
      }),
      text("Started", "a1"),
      idle({ stopReason: "end_turn" }),
    ),
  );
  expect(document.querySelector('[data-item-id="c2"]')).toBeNull();
  await user.click(within(panel).getByRole("button", { name: /Serve the app/ }));
  await waitFor(() =>
    expect(document.querySelector('[data-item-id="c2"][data-revealed]')).not.toBeNull(),
  );
});
