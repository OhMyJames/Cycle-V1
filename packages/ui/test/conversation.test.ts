import { expect, test } from "bun:test";
import type { SessionUpdate } from "@cycle/acp";
import {
  applyUpdate,
  type Block,
  type Conversation,
  canPrompt,
  emptyConversation,
  type Item,
  reduce,
  type ToolItem,
  textOf,
  usageLabel,
} from "../src/model/index.ts";

const blocksOf = (item: Item | undefined): Block[] => (item as { blocks: Block[] }).blocks;
const u = (update: object) => update as SessionUpdate;
const chunk = (kind: string, messageId: string, text: string) =>
  u({ sessionUpdate: kind, messageId, content: { type: "text", text } });
const idle = (extra: object = {}) => u({ sessionUpdate: "state_update", state: "idle", ...extra });
const tool = (c: Conversation, id: string) =>
  c.items.find((i) => i.kind === "tool" && i.id === id) as ToolItem;

test("joins the chunks of one message into one run of text", () => {
  const c = reduce([
    chunk("agent_message_chunk", "a", "Hel"),
    chunk("agent_message_chunk", "a", "lo"),
  ]);
  expect(c.items).toHaveLength(1);
  expect(c.items[0]).toMatchObject({ kind: "agent", id: "a" });
  expect(textOf(blocksOf(c.items[0]))).toBe("Hello");
  expect(blocksOf(c.items[0])).toHaveLength(1);
});

test("a message and a thought with the same id are two items", () => {
  const c = reduce([
    chunk("agent_thought_chunk", "m", "hmm"),
    chunk("agent_message_chunk", "m", "answer"),
  ]);
  expect(c.items.map((i) => i.kind)).toEqual(["thought", "agent"]);
});

test("the whole message that follows the chunks replaces them, it does not repeat them", () => {
  const c = reduce([
    chunk("agent_message_chunk", "a", "Hel"),
    chunk("agent_message_chunk", "a", "lo"),
    u({
      sessionUpdate: "agent_message",
      messageId: "a",
      content: [{ type: "text", text: "Hello" }],
    }),
  ]);
  expect(textOf(blocksOf(c.items[0]))).toBe("Hello");
});

test("a message update with no content leaves the content, and null clears it", () => {
  const base = reduce([chunk("agent_message_chunk", "a", "text")]);
  const kept = applyUpdate(base, u({ sessionUpdate: "agent_message", messageId: "a" }));
  expect(textOf(blocksOf(kept.items[0]))).toBe("text");
  const cleared = applyUpdate(
    base,
    u({ sessionUpdate: "agent_message", messageId: "a", content: null }),
  );
  expect(blocksOf(cleared.items[0])).toEqual([]);
});

test("a user message is added whole, or built from chunks", () => {
  const whole = reduce([
    u({ sessionUpdate: "user_message", messageId: "u", content: [{ type: "text", text: "hi" }] }),
  ]);
  expect(whole.items[0]).toMatchObject({ kind: "user", id: "u" });
  const built = reduce([
    chunk("user_message_chunk", "u", "h"),
    chunk("user_message_chunk", "u", "i"),
  ]);
  expect(textOf(blocksOf(built.items[0]))).toBe("hi");
});

test("a tool call is patched by its id as it goes, and keeps what an update leaves out", () => {
  const c = reduce([
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      name: "Bash",
      kind: "execute",
      status: "pending",
    }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "in_progress",
      rawInput: { command: "ls" },
    }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
    }),
  ]);
  expect(c.items).toHaveLength(1);
  expect(tool(c, "t")).toMatchObject({
    name: "Bash",
    toolKind: "execute",
    status: "completed",
    rawInput: { command: "ls" },
  });
  expect(tool(c, "t").content).toHaveLength(1);
});

test("an update for a tool seen before its first update still makes one", () => {
  const c = reduce([
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" }),
  ]);
  expect(tool(c, "t")).toMatchObject({ status: "completed", content: [] });
});

test("null clears a tool's field", () => {
  const c = reduce([
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", name: "Bash", status: "in_progress" }),
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", name: null }),
  ]);
  expect(tool(c, "t").name).toBeUndefined();
  expect(tool(c, "t").status).toBe("in_progress");
});

test("tool content can arrive as chunks", () => {
  const c = reduce([
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", name: "Bash" }),
    u({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "t",
      content: { type: "text", text: "a" },
    }),
    u({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "t",
      content: { type: "text", text: "b" },
    }),
  ]);
  expect(tool(c, "t").content).toEqual([{ type: "text", text: "ab" }]);
});

test("the turn has ended only when an idle says why", () => {
  let c = reduce([u({ sessionUpdate: "state_update", state: "running" })]);
  expect(c.status).toBe("running");
  expect(canPrompt(c)).toBe(false);
  // A snapshot of the state is idle with no reason: it is not the end of a turn.
  c = applyUpdate(c, idle());
  expect(c.status).toBe("idle");
  expect(c.turns).toBe(0);
  expect(c.lastStop).toBeUndefined();
  c = applyUpdate(
    applyUpdate(c, u({ sessionUpdate: "state_update", state: "running" })),
    idle({ stopReason: "end_turn" }),
  );
  expect(c.turns).toBe(1);
  expect(c.lastStop).toEqual({ stopReason: "end_turn" });
  expect(canPrompt(c)).toBe(true);
});

test("a snapshot applied twice changes nothing", () => {
  const once = reduce([idle(), u({ sessionUpdate: "state_update", state: "running" })]);
  const twice = applyUpdate(
    applyUpdate(once, u({ sessionUpdate: "state_update", state: "running" })),
    u({ sessionUpdate: "state_update", state: "running" }),
  );
  expect(twice).toEqual(once);
});

test("a turn that is cancelled or fails ends the tools that were still going", () => {
  const start = reduce([
    u({ sessionUpdate: "tool_call_update", toolCallId: "a", name: "Bash", status: "in_progress" }),
    u({ sessionUpdate: "tool_call_update", toolCallId: "b", name: "Read", status: "completed" }),
  ]);
  const cancelled = applyUpdate(start, idle({ stopReason: "cancelled" }));
  expect(tool(cancelled, "a").status).toBe("cancelled");
  expect(tool(cancelled, "b").status).toBe("completed");
  const ended = applyUpdate(start, idle({ stopReason: "end_turn" }));
  expect(tool(ended, "a").status).toBe("in_progress");
  const failed = applyUpdate(
    start,
    idle({ stopReason: "error", error: { code: -32012, message: "The agent exited" } }),
  );
  expect(failed.lastStop).toEqual({
    stopReason: "error",
    error: { code: -32012, message: "The agent exited" },
  });
});

test("a plan is replaced by its id", () => {
  const entries = (s: string) => [{ content: "do it", priority: "high", status: s }];
  const c = reduce([
    u({
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "p", entries: entries("pending") },
    }),
    u({
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "p", entries: entries("completed") },
    }),
  ]);
  expect(c.items).toHaveLength(1);
  expect(c.items[0]).toMatchObject({ kind: "plan", entries: [{ status: "completed" }] });
});

test("replay_complete ends the replay, and usage is kept", () => {
  const c = reduce(
    [
      u({ sessionUpdate: "usage_update", used: 10, size: 100 }),
      u({ sessionUpdate: "replay_complete" }),
    ],
    {
      ...emptyConversation(),
      replaying: true,
    },
  );
  expect(c.replaying).toBe(false);
  expect(c.usage).toEqual({ used: 10, size: 100 });
});

test("an update of a kind it does not know is counted and does no harm", () => {
  const c = reduce([
    u({ sessionUpdate: "_vendor_thing", x: 1 }),
    chunk("agent_message_chunk", "a", "ok"),
  ]);
  expect(c.ignored).toBe(1);
  expect(c.items).toHaveLength(1);
});

test("never changes the conversation it was given", () => {
  const before = reduce([chunk("agent_message_chunk", "a", "x")]);
  const frozen = JSON.stringify(before);
  applyUpdate(before, chunk("agent_message_chunk", "a", "y"));
  applyUpdate(before, idle({ stopReason: "end_turn" }));
  expect(JSON.stringify(before)).toBe(frozen);
});

test("a whole history replayed gives the conversation that was built live", () => {
  const updates = [
    u({ sessionUpdate: "user_message", messageId: "u", content: [{ type: "text", text: "go" }] }),
    u({ sessionUpdate: "state_update", state: "running" }),
    chunk("agent_thought_chunk", "m", "think"),
    chunk("agent_message_chunk", "m", "do"),
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", name: "Bash", status: "pending" }),
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" }),
    idle({ stopReason: "end_turn" }),
  ];
  const live = updates.reduce(applyUpdate, emptyConversation());
  const replayed = reduce([...updates, u({ sessionUpdate: "replay_complete" })], {
    ...emptyConversation(),
    replaying: true,
  });
  expect({ ...replayed, replaying: live.replaying }).toEqual(live);
});

test("usage keeps its cost until a new one comes, and null clears it", () => {
  const at = (...updates: object[]) =>
    updates.reduce<Conversation>((c, x) => applyUpdate(c, x as never), emptyConversation());
  const cost = { amount: 0.5, currency: "USD" };
  expect(at({ sessionUpdate: "usage_update", used: 1, size: 10, cost }).usage?.cost).toEqual(cost);
  expect(
    at(
      { sessionUpdate: "usage_update", used: 1, size: 10, cost },
      { sessionUpdate: "usage_update", used: 2, size: 10 },
    ).usage,
  ).toEqual({ used: 2, size: 10, cost });
  expect(
    at(
      { sessionUpdate: "usage_update", used: 1, size: 10, cost },
      { sessionUpdate: "usage_update", used: 2, size: 10, cost: null },
    ).usage,
  ).toEqual({ used: 2, size: 10 });
});

test("the header's words for usage", () => {
  expect(usageLabel({ used: 25_000, size: 200_000 })).toBe("13% of context");
  expect(usageLabel({ used: 1, size: 10, cost: { amount: 0.0123, currency: "USD" } })).toBe(
    "10% of context · $0.012",
  );
  expect(usageLabel({ used: 1, size: 10, cost: { amount: 1.5, currency: "USD" } })).toBe(
    "10% of context · $1.50",
  );
});
