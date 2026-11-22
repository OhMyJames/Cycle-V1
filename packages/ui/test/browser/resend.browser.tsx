import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { $createParagraphNode, $getRoot } from "lexical";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { SessionSnapshot } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { boxText, editorOf, press, ready, write } from "./box.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const u = (update: object) => update as SessionUpdate;
const you = (text: string) =>
  u({ sessionUpdate: "user_message", messageId: "m1", content: [{ type: "text", text }] });
const tool = (id: string, name: string, kind: string, status: string) =>
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name, kind, status, rawInput: {} });
const state = (extra: object) => u({ sessionUpdate: "state_update", ...extra });
const failed = state({
  state: "idle",
  stopReason: "error",
  error: { code: -32012, message: "The agent exited" },
});

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
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  const tracked = () =>
    script.calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);
  return { user, box, script, tracked };
};

test("a failed turn's message goes back in the box to be read, not sent, and is sent as any message", async () => {
  const { user, box, script, tracked } = await open(
    you("Fix the flaky test in queue.test.ts"),
    state({ state: "running" }),
    tool("r", "Read", "read", "completed"),
    failed,
  );
  const alert = await screen.findByRole("alert");
  await user.click(within(alert).getByRole("button", { name: "Send again" }));
  // Back in the box, which has the focus; nothing went out, and no question was asked: nothing had changed.
  await waitFor(() => expect(boxText(box)).toBe("Fix the flaky test in queue.test.ts"));
  expect(box.contains(document.activeElement)).toBe(true);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(script.named("prompt")).toHaveLength(0);
  expect(tracked()).toContainEqual([
    "turn_resend_opened",
    { failure: "agent_exited", changed: false },
  ]);
  // A second press does not put it there twice.
  await user.click(within(alert).getByRole("button", { name: "Send again" }));
  expect(boxText(box)).toBe("Fix the flaky test in queue.test.ts");
  expect(tracked().filter(([event]) => event === "turn_resend_opened")).toHaveLength(1);

  await press(box, "Enter");
  await waitFor(() => expect(script.named("prompt")).toHaveLength(1));
  expect(script.named("prompt")[0]?.[3]).toEqual([
    { type: "text", text: "Fix the flaky test in queue.test.ts" },
  ]);
  await waitFor(() => expect(tracked()).toContainEqual(["turn_resent", { edited: false }]));
  // What was said is not what is reported.
  expect(JSON.stringify(tracked())).not.toContain("flaky");
});

test("a turn that had run a command says so before its message goes back, and a changed message is counted as changed", async () => {
  const { user, box, tracked } = await open(
    you("Deploy it"),
    state({ state: "running" }),
    tool("b", "Bash", "execute", "completed"),
    tool("e", "Edit", "edit", "in_progress"),
    tool("w", "Write", "edit", "pending"),
    failed,
  );
  const alert = await screen.findByRole("alert");
  await user.click(within(alert).getByRole("button", { name: "Send again" }));
  const dialog = await screen.findByRole("alertdialog");
  // The calls that began are named; the one that only waited is not.
  expect(dialog.textContent).toContain("Bash and Edit");
  expect(dialog.textContent).not.toContain("Write");
  expect(boxText(box)).toBe("");
  await user.click(within(dialog).getByRole("button", { name: "Put the message back" }));
  await waitFor(() => expect(boxText(box)).toBe("Deploy it"));
  expect(tracked()).toContainEqual([
    "turn_resend_opened",
    { failure: "agent_exited", changed: true },
  ]);

  await write(box, " to staging only");
  await press(box, "Enter");
  await waitFor(() => expect(tracked()).toContainEqual(["turn_resent", { edited: true }]));
});

test("cancel leaves the box as it was", async () => {
  const { user, box, tracked } = await open(
    you("Deploy it"),
    state({ state: "running" }),
    tool("b", "Bash", "execute", "completed"),
    failed,
  );
  await user.click(
    within(await screen.findByRole("alert")).getByRole("button", { name: "Send again" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(boxText(box)).toBe("");
  expect(tracked().filter(([event]) => event === "turn_resend_opened")).toHaveLength(0);
});

test("a message put back and then cleared away is not counted when something else is sent", async () => {
  const { user, box, tracked } = await open(you("Old words"), failed);
  await user.click(
    within(await screen.findByRole("alert")).getByRole("button", { name: "Send again" }),
  );
  await waitFor(() => expect(boxText(box)).toBe("Old words"));
  // The person empties the box.
  await act(() => {
    editorOf(box).update(() => $getRoot().clear().append($createParagraphNode()), {
      discrete: true,
    });
  });
  await waitFor(() => expect(boxText(box)).toBe(""));
  await write(box, "Something else");
  await press(box, "Enter");
  await waitFor(() => expect(boxText(box)).toBe(""));
  expect(tracked().filter(([event]) => event === "turn_resent")).toHaveLength(0);
});

test("only a failure offers it: a stop by the person does not", async () => {
  await open(you("Do it"), state({ state: "idle", stopReason: "cancelled" }));
  await screen.findByText("Stopped before it finished.");
  expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
});

test("while the agent tries its request again, the step line says so and the conversation has no row for it", async () => {
  const { box } = await open(
    you("Go"),
    state({ state: "running" }),
    u({
      sessionUpdate: "notice",
      severity: "info",
      title: "Retrying the request (attempt 2 of 10)",
      _meta: { "cycle/retry": { attempt: 2, maxRetries: 10, delayMs: 500 } },
    }),
  );
  expect(box).toBeTruthy();
  await screen.findByText("The request failed, trying again (2 of 10)…");
  const log = screen.getByRole("log", { name: "Conversation" });
  expect(log.textContent).not.toContain("Retrying the request");
  expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
});
