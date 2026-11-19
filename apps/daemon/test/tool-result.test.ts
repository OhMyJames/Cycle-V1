import { expect, test } from "bun:test";
import { checkToolResult } from "../src/tool-result.ts";

const update = (meta: unknown) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: "t",
  status: "completed",
  _meta: meta,
});

test("a tool call's counts are kept when they match the protocol, and left out when they do not", () => {
  const good = update({ "cycle/toolResult": { edit: { additions: 2, deletions: 1 } } });
  expect(checkToolResult("update", good)).toBe(good);
  expect(
    checkToolResult("update", update({ "cycle/toolResult": { search: { files: "3" } } })),
  ).toEqual({
    sessionUpdate: "tool_call_update",
    toolCallId: "t",
    status: "completed",
  });
  // Other keys of `_meta` stay; only the bad one goes.
  expect(
    checkToolResult(
      "update",
      update({ "cycle/toolResult": { read: { startLine: 1.5, numLines: 1 } }, other: 1 }),
    ),
  ).toMatchObject({ _meta: { other: 1 } });
  // Not a tool call, or none to check: as it was.
  const text = { sessionUpdate: "agent_message_chunk", _meta: { "cycle/toolResult": "x" } };
  expect(checkToolResult("update", text)).toBe(text);
  expect(checkToolResult("request", good)).toBe(good);
});
