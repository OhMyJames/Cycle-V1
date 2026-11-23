import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { applyUpdate, emptyConversation, sessionEdits } from "../src/model/index.ts";

const u = (update: object) => update as SessionUpdate;
const patch = (path: string, text: string) => ({
  type: "diff",
  changes: [{ operation: "modify", path }],
  patch: { format: "git_patch", text },
});
const PATCH = "@@ -1,1 +1,2 @@\n-a\n+b\n+c\n";

const edit = (
  id: string,
  path: string,
  status = "completed",
  content: object[] = [patch(path, PATCH)],
) => [
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name: "Edit", status: "pending" }),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status, content }),
];

test("a session's edits are its finished file edits, by turn, the latest turn first, with what was asked", () => {
  const updates = [
    u({
      sessionUpdate: "user_message",
      messageId: "m1",
      content: [{ type: "text", text: "Fix the bug" }],
    }),
    ...edit("t1", "/work/a.ts"),
    ...edit("t2", "/work/b.ts"),
    u({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }),
    u({
      sessionUpdate: "user_message",
      messageId: "m2",
      content: [{ type: "text", text: "Now the docs" }],
    }),
    // Failed: it changed nothing.
    ...edit("t3", "/work/c.md", "failed"),
    ...edit("t4", "/work/d.md"),
    // A read is not an edit.
    u({ sessionUpdate: "tool_call_update", toolCallId: "t5", name: "Read", status: "completed" }),
  ];
  const conversation = updates.reduce((c, x) => applyUpdate(c, x), emptyConversation());
  const turns = sessionEdits(conversation);
  expect(
    turns.map((t) => [t.prompt, t.edits.map((e) => e.path), t.additions, t.deletions]),
  ).toEqual([
    ["Now the docs", ["/work/d.md"], 2, 1],
    ["Fix the bug", ["/work/a.ts", "/work/b.ts"], 4, 2],
  ]);
  expect(turns[1]?.edits[0]).toMatchObject({ toolId: "t1", created: false, staged: false });
  expect(turns[1]?.edits[0]?.lines?.map((l) => l.kind)).toEqual(["hunk", "del", "add", "add"]);
});

test("no edits, no turns", () => {
  expect(sessionEdits(emptyConversation())).toEqual([]);
});
