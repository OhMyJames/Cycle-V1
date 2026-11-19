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
  let version = updates.length;
  const emit = (update: SessionUpdate) => {
    version += 1;
    return act(() =>
      script.emit({ type: "update", environmentId: "local", sessionId: "s1", update, version }),
    );
  };
  return { user, log, emit };
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
  expect(card.getAttribute("aria-expanded")).toBe("false");
  expect(log.textContent).not.toContain("a.ts");
  await user.click(card);
  expect(card.getAttribute("aria-expanded")).toBe("true");
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

test("a tool row says what it did with a verb in its tense, and only a failure says so in a word", async () => {
  const { log, emit } = await open(
    you("u1"),
    ...tool("a", "Bash", "in_progress", { command: "bun test" }),
    state({ state: "running" }),
  );
  const row = await screen.findByRole("button", { name: /Running/ });
  expect(row.textContent).toContain("bun test");
  // The tool's name is still in what a screen reader is told.
  expect(row.textContent).toContain("Bash");
  await emit(u({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Ran/ })).toBeTruthy());
  await emit(u({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "failed" }));
  await waitFor(() =>
    expect(log.querySelector('[data-slot="tool-status"]')?.textContent).toBe("failed"),
  );
});

test("a call with a description reads as it; what it ran follows, and a mention is not drawn twice", async () => {
  const { log } = await open(
    u({
      sessionUpdate: "user_message",
      messageId: "u1",
      content: [
        { type: "text", text: "Look at @src/a.ts" },
        {
          type: "resource_link",
          name: "a.ts",
          uri: "file:///p/src/a.ts",
          _meta: { "cycle/mention": "src/a.ts" },
        },
      ],
    }),
    ...tool("a", "Bash", "completed", { command: "bun test", description: "Run the tests" }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const row = await screen.findByRole("button", { name: /Run the tests/ });
  expect(row.querySelector('[data-slot="tool-verb"]')?.textContent).toBe("Run the tests");
  expect(row.querySelector('[data-slot="tool-summary"]')?.textContent).toBe("bun test");
  expect(log.textContent).not.toContain("resource_link");
  expect(log.textContent).toContain("@src/a.ts");
});

test("only a purpose sentence is a description: an MCP tool's description field is content, not the line", async () => {
  await open(
    you("u1"),
    ...tool("a", "mcp__tracker__create_issue", "completed", {
      title: "Fix login",
      description: "A long body\nwith several lines",
    }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const row = await screen.findByRole("button", { name: /mcp__tracker__create_issue/ });
  expect(row.querySelector('[data-slot="tool-verb"]')?.textContent).toBe(
    "mcp__tracker__create_issue",
  );
  expect(row.textContent).not.toContain("A long body");
});

test("a turn that failed says how, and the failed call is a row under the card, not in it", async () => {
  const { log } = await open(
    you("u1"),
    ...tool("a", "Bash", "completed", { command: "make" }),
    ...tool("b", "Bash", "completed", { command: "make test" }),
    ...tool("c", "Bash", "failed", { command: "make install" }),
    state({ state: "idle", stopReason: "error", error: { message: "disk full" } }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The turn failed: disk full");
  const card = await screen.findByRole("button", { name: /Ran 2 commands/ });
  const row = await screen.findByRole("button", { name: /Bash.*make install/ });
  // Outside the card (which holds the two that went well), and open: its input is on screen.
  expect(card.closest('[data-kind="work"]')?.contains(row)).toBe(false);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(log.textContent).not.toContain("make test");
});

test("a failure that arrives while the card is on screen opens it", async () => {
  const { log, emit } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("a", "Bash", "in_progress", { command: "make" }),
    ...tool("b", "Bash", "in_progress", { command: "make test" }),
  );
  const card = await screen.findByRole("button", { name: /Ran 2 commands/ });
  expect(card.getAttribute("aria-expanded")).toBe("false");
  await emit(
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "b",
      status: "failed",
      rawInput: { command: "make test" },
    }),
  );
  await waitFor(() => expect(card.getAttribute("aria-expanded")).toBe("true"));
  // The other call is still going, and the card says both.
  expect(log.textContent).toContain("Running");
  expect(log.textContent).toContain("1 failed");
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
  const choice = await screen.findByRole("menuitemcheckbox", { name: "Show thinking" });
  expect(choice.getAttribute("aria-checked")).toBe("false");
  await user.click(choice);
  // A checkbox item leaves the menu open, so that the change can be seen; close it.
  await user.keyboard("{Escape}");
  // The thought is a row now: it opens to its text.
  const row = await screen.findByRole("button", { name: "Thinking" });
  await user.click(row);
  await waitFor(() => expect(log.textContent).toContain("weighing the options"));
  expect(thinking.get()).toBe(true);
});

const turnsOf = (n: number, from = 0) =>
  Array.from({ length: n }, (_, k) => [
    you(`question ${from + k}`),
    u({
      sessionUpdate: "agent_message",
      messageId: `m${from + k}`,
      content: [{ type: "text", text: `answer ${from + k}` }],
    }),
    state({ state: "idle", stopReason: "end_turn" }),
  ]).flat();

const drawn = (log: HTMLElement) => log.querySelectorAll('[data-slot="block"]').length;

test("a long conversation draws its end, and the button brings the earlier blocks a page at a time", async () => {
  const { user, log } = await open(...turnsOf(70));
  await waitFor(() => expect(log.textContent).toContain("answer 69"));
  // 140 blocks; the last 60 are drawn: question 40 is the first, question 39 is not.
  expect(drawn(log)).toBe(60);
  expect(log.textContent).toContain("question 40");
  expect(log.textContent).not.toContain("question 39");
  await user.click(screen.getByRole("button", { name: "Show earlier" }));
  await waitFor(() => expect(log.textContent).toContain("question 10"));
  expect(drawn(log)).toBe(120);
  expect(log.textContent).not.toContain("question 9");
  await user.click(screen.getByRole("button", { name: "Show earlier" }));
  await waitFor(() => expect(log.textContent).toContain("question 0"));
  expect(drawn(log)).toBe(140);
  // Everything is drawn: there is nothing earlier, and the focus did not fall out of the page.
  expect(screen.queryByRole("button", { name: "Show earlier" })).toBeNull();
  expect(document.activeElement).toBe(log);
});

test("a conversation that grows from a few blocks to many draws about a page, not all of it", async () => {
  const { log, emit } = await open(...turnsOf(1));
  expect(drawn(log)).toBe(2);
  for (const update of turnsOf(70, 1)) await emit(update);
  await waitFor(() => expect(log.textContent).toContain("answer 70"));
  // The reader is at the end: the window is the last page, however the conversation got there.
  expect(drawn(log)).toBe(60);
  expect(log.textContent).not.toContain("question 20");
});

test("a tool call left going in a turn that has ended is not shown running; in a card it is not done", async () => {
  const { log, emit } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("a", "Bash", "in_progress", { command: "sed -n 1,60p icons.tsx" }),
  );
  const row = await screen.findByRole("button", { name: /Bash/ });
  expect(row.textContent).toContain("in progress");
  expect(log.querySelector('[data-slot="spinner"]')).not.toBeNull();
  // An older session: the turn ended and the call never said it had.
  await emit(state({ state: "idle", stopReason: "end_turn" }));
  await waitFor(() => expect(row.textContent).toContain("cancelled"));
  expect(log.querySelector('[data-slot="spinner"]')).toBeNull();
});

test("a card with a call the turn left is not finished, not done", async () => {
  await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("a", "Bash", "completed", { command: "ls" }),
    ...tool("b", "Bash", "in_progress", { command: "make" }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const card = await screen.findByRole("button", { name: /Ran 2 commands/ });
  expect(card.textContent).toContain("not finished");
  expect(card.closest('[data-kind="work"]')?.getAttribute("data-status")).toBe("pending");
});

const finished = (id: string, name: string, rawInput: object, result: object) => [
  ...tool(id, name, "in_progress", rawInput),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", ...result }),
];

test("an edit's line counts its own lines and opens to them, not to the strings it was given", async () => {
  const { user, log } = await open(
    you("u1"),
    ...finished(
      "e",
      "Edit",
      { file_path: "src/a.ts", old_string: "OLD-INPUT", new_string: "NEW-INPUT" },
      {
        content: [
          {
            type: "diff",
            changes: [{ operation: "modify", path: "/r/src/a.ts" }],
            patch: {
              format: "git_patch",
              text: "--- a\n+++ b\n@@ -7,2 +7,3 @@\n keep\n-gone\n+here\n+also\n",
            },
          },
        ],
        _meta: { "cycle/toolResult": { edit: { additions: 2, deletions: 1 } } },
      },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const row = await screen.findByRole("button", { name: /Edited/ });
  expect(row.textContent).toContain("+2");
  expect(row.textContent).toContain("−1");
  // In words for a screen reader, not only in colour and signs.
  expect(row.textContent).toContain("2 lines added, 1 removed");
  await user.click(row);
  const diff = log.querySelector('[data-slot="tool-diff"]');
  expect(
    [...(diff?.querySelectorAll("[data-line]") ?? [])].map((l) => l.getAttribute("data-line")),
  ).toEqual(["context", "del", "add", "add"]);
  expect(diff?.textContent).toContain("here");
  expect(log.textContent).not.toContain("OLD-INPUT");
});

test("a new file is Created; a read says its lines; a search what it found; a picture read is shown", async () => {
  const { user, log } = await open(
    you("u1"),
    ...finished(
      "w",
      "Write",
      { file_path: "README.md", content: "…" },
      {
        content: [
          { type: "diff", changes: [{ operation: "add", path: "/r/README.md" }], patch: null },
        ],
        _meta: { "cycle/toolResult": { edit: { additions: 3, deletions: 0, created: true } } },
      },
    ),
    u({
      sessionUpdate: "agent_message",
      messageId: "m1",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "z",
      "Write",
      { file_path: "__init__.py", content: "" },
      {
        content: [
          { type: "diff", changes: [{ operation: "add", path: "/r/__init__.py" }], patch: null },
        ],
        _meta: {
          "cycle/toolResult": { edit: { additions: 0, deletions: 0, created: true, staged: true } },
        },
      },
    ),
    u({
      sessionUpdate: "agent_message",
      messageId: "m1b",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "r",
      "Read",
      { file_path: "a.ts" },
      { _meta: { "cycle/toolResult": { read: { startLine: 20, numLines: 40, totalLines: 212 } } } },
    ),
    u({
      sessionUpdate: "agent_message",
      messageId: "m2",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "g",
      "Grep",
      { pattern: "PORT" },
      { _meta: { "cycle/toolResult": { search: { files: 2, matches: 5 } } } },
    ),
    u({
      sessionUpdate: "agent_message",
      messageId: "m3",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "p",
      "Read",
      { file_path: "a.png" },
      {
        content: [
          {
            type: "content",
            content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          },
        ],
      },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const created = await screen.findByRole("button", { name: /Created README/ });
  await user.click(created);
  expect(log.textContent).toContain("The change is too large to show here.");
  expect(log.textContent).toContain("lines 20–59 of 212");
  // An empty new file held for review says both.
  expect(log.textContent).toContain("empty file held for review");
  expect(log.textContent).toContain("5 matches in 2 files");
  await user.click(screen.getByRole("button", { name: /a\.png/ }));
  await waitFor(() => expect(log.querySelector('[data-kind="tool"] img')).toBeTruthy());
  // Neither input is shown again: the new file's is the file, the read's says only the path the line shows.
  expect(log.querySelector('[data-slot="tool-input"]')).toBeNull();
});

test("a deletion-only edit shows only removed lines, not +0", async () => {
  await open(
    you("u1"),
    ...finished(
      "d",
      "Edit",
      { file_path: "src/old.ts", old_string: "a\nb\n", new_string: "" },
      {
        content: [
          {
            type: "diff",
            changes: [{ operation: "modify", path: "/r/src/old.ts" }],
            patch: { format: "git_patch", text: "--- a\n+++ b\n@@ -1,2 +1,0 @@\n-a\n-b\n" },
          },
        ],
        _meta: { "cycle/toolResult": { edit: { additions: 0, deletions: 2 } } },
      },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const row = await screen.findByRole("button", { name: /Edited/ });
  expect(row.textContent).toContain("−2");
  expect(row.textContent).not.toContain("+0");
});
