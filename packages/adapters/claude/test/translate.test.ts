import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { stopReasonOf, TurnTranslator, toolKind } from "../src/index.ts";
import { textTurn } from "./fake-query.ts";

const feedAll = (messages: SDKMessage[]) => {
  const translator = new TurnTranslator();
  return messages.flatMap((m) => translator.feed(m));
};

test("streams text as chunks and does not repeat it in the whole message", () => {
  const updates = feedAll(textTurn("s", "msg_1", "Hello there"));
  expect(updates.map((u) => u.sessionUpdate)).toEqual([
    "agent_message_chunk",
    "agent_message_chunk",
  ]);
  const text = updates.map((u) => (u as { content: { text: string } }).content.text).join("");
  expect(text).toBe("Hello there");
  expect(updates.every((u) => (u as { messageId: string }).messageId === "msg_1")).toBe(true);
});

test("sends a whole message that was never streamed", () => {
  const updates = feedAll([
    {
      type: "assistant",
      message: { id: "msg_2", content: [{ type: "text", text: "From a cache" }] },
    } as unknown as SDKMessage,
  ]);
  expect(updates).toEqual([
    {
      sessionUpdate: "agent_message",
      messageId: "msg_2",
      content: [{ type: "text", text: "From a cache" }],
    },
  ]);
});

test("streams thinking as thought chunks", () => {
  const updates = feedAll([
    { type: "stream_event", event: { type: "message_start", message: { id: "m" } } },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
    },
  ] as unknown as SDKMessage[]);
  expect(updates.map((u) => u.sessionUpdate)).toEqual(["agent_thought_chunk"]);
});

test("follows a tool call from pending to its result", () => {
  const updates = feedAll([
    { type: "stream_event", event: { type: "message_start", message: { id: "m" } } },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Bash" },
      },
    },
    {
      type: "assistant",
      message: {
        id: "m",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
    },
  ] as unknown as SDKMessage[]);
  expect(updates.map((u) => (u as { status?: string }).status)).toEqual([
    "pending",
    "in_progress",
    "completed",
  ]);
  expect(updates[0]).toMatchObject({ toolCallId: "t1", name: "Bash", kind: "execute" });
  expect(updates[1]).toMatchObject({ rawInput: { command: "ls" } });
  expect(updates[2]).toMatchObject({
    content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
  });
});

test("a failed tool result is failed", () => {
  const [update] = feedAll([
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
      },
    } as unknown as SDKMessage,
  ]);
  expect(update).toMatchObject({ status: "failed" });
});

test("maps how a turn ended", () => {
  const result = (extra: object) => ({ type: "result", ...extra }) as unknown as SDKMessage;
  expect(stopReasonOf(result({ subtype: "success", stop_reason: "end_turn" }))).toEqual({
    stopReason: "end_turn",
  });
  expect(stopReasonOf(result({ subtype: "success", stop_reason: "max_tokens" }))).toEqual({
    stopReason: "max_tokens",
  });
  expect(stopReasonOf(result({ subtype: "error_max_turns" }))).toEqual({
    stopReason: "max_turn_requests",
  });
  expect(stopReasonOf(result({ subtype: "error_during_execution" }))).toMatchObject({
    stopReason: "error",
  });
});

test("sorts tools into ACP's kinds", () => {
  expect(toolKind("Read")).toBe("read");
  expect(toolKind("Edit")).toBe("edit");
  expect(toolKind("Grep")).toBe("search");
  expect(toolKind("mcp__x__y")).toBe("other");
});
