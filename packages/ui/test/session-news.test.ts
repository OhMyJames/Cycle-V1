import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { ToolItem } from "../src/model/index.ts";
import { applyUpdate, blocksOf, emptyConversation } from "../src/model/index.ts";

const reduce = (...updates: object[]) =>
  (updates as SessionUpdate[]).reduce((c, u) => applyUpdate(c, u), emptyConversation());
const call = (id: string, name: string, kind: string, status: string) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  name,
  kind,
  status,
});
const news = (state: object | undefined, meta: object) => ({
  sessionUpdate: "subagent_update",
  sessionId: "task-1",
  ...(state !== undefined ? { state } : {}),
  _meta: { "cycle/subagent": { toolCallId: "a", ...meta } },
});

test("a sub-agent's news goes onto the call that started it; what an update leaves out stays", () => {
  const c = reduce(
    call("a", "Agent", "other", "in_progress"),
    news({ state: "running" }, { background: true }),
    news(undefined, { lastTool: "Read" }),
    call("a", "Agent", "other", "completed"),
    news(
      { state: "idle", stopReason: "end_turn" },
      { usage: { tokens: 9, toolUses: 4, durationMs: 63000 } },
    ),
  );
  const tool = c.items[0] as ToolItem;
  expect(tool.subagent).toEqual({
    state: "done",
    background: true,
    lastTool: "Read",
    usage: { tokens: 9, toolUses: 4, durationMs: 63000 },
  });
  // News that comes before its call waits for it; a count left out stays.
  const early = reduce(
    news({ state: "running" }, { background: true, usage: { toolUses: 7, durationMs: 42000 } }),
    news(undefined, { usage: { tokens: 5000 } }),
    call("a", "Agent", "other", "in_progress"),
  );
  expect((early.items[0] as ToolItem).subagent).toEqual({
    state: "running",
    background: true,
    usage: { tokens: 5000, toolUses: 7, durationMs: 42000 },
  });
  expect(early.waiting).toEqual({});
  // A sub-agent's own sub-agent: its call is never seen here, so its news is not kept.
  const nested = reduce(news({ state: "running" }, { parentId: "task-0" }));
  expect(nested.waiting).toEqual({});
  // News whose call never comes does not pile up.
  const many = reduce(
    ...Array.from({ length: 40 }, (_, n) => ({
      ...news({ state: "running" }, {}),
      _meta: { "cycle/subagent": { toolCallId: `x${n}` } },
    })),
  );
  expect(Object.keys(many.waiting).length).toBeLessThanOrEqual(16);
});

test("a compaction is one line where it began, and changes in place", () => {
  const c = reduce(
    { sessionUpdate: "compaction_update", compactionId: "k", status: "in_progress" },
    {
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "k",
      content: { type: "text", text: "notes" },
    },
    { sessionUpdate: "compaction_update", compactionId: "k", status: "completed" },
  );
  expect(c.items).toEqual([{ kind: "compaction", id: "k", turn: 0, status: "completed" }]);
  expect(blocksOf(c, { showThinking: false }).map((b) => b.kind)).toEqual(["compaction"]);
});

test("changing the plan is not a row, even while it goes; one that failed is, and neither cuts a stretch of work", () => {
  const c = reduce(
    call("r", "Read", "read", "completed"),
    call("t", "TaskCreate", "think", "completed"),
    call("g", "TaskCreate", "think", "in_progress"),
    call("e", "Edit", "edit", "completed"),
    call("u", "TaskUpdate", "think", "failed"),
  );
  const [work] = blocksOf(c, { showThinking: false });
  expect(work?.kind === "work" ? work.tools.map((t) => t.id) : []).toEqual(["r", "e", "u"]);
});
