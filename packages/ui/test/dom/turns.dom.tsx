import { afterEach, beforeEach, expect, test } from "bun:test";
import type { SessionUpdate } from "@cycle/acp";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionSnapshot } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { thinking } from "../../src/thinking.ts";
import { fakeBridge } from "../fake-bridge.ts";

beforeEach(() => thinking.set(false));
afterEach(() => {
  cleanup();
  thinking.set(false);
});

const u = (update: object) => update as SessionUpdate;
const you = (id: string) =>
  u({ sessionUpdate: "user_message", messageId: id, content: [{ type: "text", text: id }] });
const think = (id: string, text: string) =>
  u({ sessionUpdate: "agent_thought", messageId: id, content: [{ type: "text", text }] });
const tool = (id: string, name: string, status: string, rawInput: object) => [
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name, status: "pending" }),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status, rawInput }),
];
const state = (extra: object) => u({ sessionUpdate: "state_update", ...extra });

const open = async (...updates: SessionUpdate[]) => {
  const snapshot = (): SessionSnapshot => ({
    conversation: updates.reduce(applyUpdate, emptyConversation()),
    permissions: [],
    version: updates.length,
  });
  const script = fakeBridge({ connected: true, snapshot });
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  await user.click(await screen.findByRole("option", { name: /work/ }));
  const log = await screen.findByRole("log", { name: "Conversation" });
  return { user, log };
};

test("two tool calls in a row are one card that says what they were, and opens to the rows", async () => {
  const { user, log } = await open(
    you("u1"),
    ...tool("a", "Bash", "completed", { command: "ls" }),
    ...tool("b", "Read", "completed", { file_path: "a.ts" }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const card = await screen.findByRole("button", { name: /Ran 1 command and read 1 file/ });
  // Closed: the rows are not on screen yet.
  expect(log.textContent).not.toContain("a.ts");
  await user.click(card);
  await waitFor(() => expect(log.textContent).toContain("a.ts"));
});

test("a single tool call is a row of its own, not a card", async () => {
  const { log } = await open(
    you("u1"),
    ...tool("a", "Bash", "completed", { command: "ls -la" }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await waitFor(() => expect(log.textContent).toContain("ls -la"));
  expect(log.textContent).not.toContain("Ran 1 command");
});

test("a turn that failed says how, and the failed call is out of the card, open", async () => {
  const { log } = await open(
    you("u1"),
    ...tool("a", "Bash", "completed", { command: "make" }),
    ...tool("b", "Bash", "failed", { command: "make install" }),
    state({ state: "idle", stopReason: "error", error: { message: "disk full" } }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The turn failed: disk full");
  // The failure is a row of its own, opened: its input is on screen.
  await waitFor(() => expect(log.textContent).toContain("make install"));
  expect(log.textContent).toContain("failed");
});

test("a turn the person stopped says so, with the word and not only a colour", async () => {
  await open(you("u1"), state({ state: "idle", stopReason: "cancelled" }));
  await screen.findByText("Stopped before it finished.");
});

test("thinking is hidden until asked for, and the line at the end still says the agent is at it", async () => {
  const { user, log } = await open(
    you("u1"),
    state({ state: "running" }),
    think("t1", "weighing the options"),
  );
  await waitFor(() => expect(log.textContent).toContain("Thinking…"));
  expect(log.textContent).not.toContain("weighing the options");
  await user.click(screen.getByRole("button", { name: "Session actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Show thinking" }));
  // The thought is a row now: it opens to its text.
  const row = await screen.findByRole("button", { name: "Thinking" });
  await user.click(row);
  await waitFor(() => expect(log.textContent).toContain("weighing the options"));
  expect(thinking.get()).toBe(true);
});
