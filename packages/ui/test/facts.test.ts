import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { ToolItem } from "../src/model/index.ts";
import { applyUpdate, diffLines, emptyConversation, toolFacts } from "../src/model/index.ts";

const PATCH = [
  "diff --git a/x.ts b/x.ts",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -10,3 +10,4 @@",
  " keep",
  "-old",
  "+new",
  "+more",
  " end",
  "@@ -40,1 +41,1 @@",
  "-a",
  "+b",
  "",
].join("\n");

const call = (over: Partial<ToolItem>): ToolItem => ({
  kind: "tool",
  id: "t",
  turn: 0,
  content: [],
  status: "completed",
  ...over,
});

test("a patch's lines carry their numbers: new for kept and added lines, old for removed ones; headers are dropped", () => {
  const lines = diffLines(PATCH);
  expect(lines.map((l) => [l.kind, l.line ?? null, l.text])).toEqual([
    ["hunk", null, "@@ -10,3 +10,4 @@"],
    ["context", 10, "keep"],
    ["del", 11, "old"],
    ["add", 11, "new"],
    ["add", 12, "more"],
    ["context", 13, "end"],
    ["hunk", null, "@@ -40,1 +41,1 @@"],
    ["del", 40, "a"],
    ["add", 41, "b"],
  ]);
  expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
});

test("an edit's counts come from the agent, or from its patch when it sent none", () => {
  const diff = {
    type: "diff",
    changes: [{ operation: "modify", path: "/x.ts" }],
    patch: { format: "git_patch", text: PATCH },
  };
  expect(toolFacts(call({ name: "Edit", content: [diff] })).edit).toMatchObject({
    created: false,
    additions: 3,
    deletions: 2,
    staged: false,
  });
  const big = { type: "diff", changes: [{ operation: "add", path: "/x.ts" }], patch: null };
  expect(
    toolFacts(
      call({
        name: "Write",
        content: [big],
        result: { edit: { additions: 9000, deletions: 0, created: true, staged: true } },
      }),
    ).edit,
  ).toEqual({ created: true, additions: 9000, deletions: 0, staged: true });
  // No patch and no counts: nothing to say.
  expect(toolFacts(call({ name: "Write", content: [big] })).edit).toBeUndefined();
});

test("a failed command says its exit code", () => {
  expect(
    toolFacts(call({ name: "Bash", status: "failed", result: { run: { exitCode: 2 } } })).run,
  ).toEqual({
    interrupted: false,
    background: false,
    exitCode: 2,
  });
});

test("reads, searches and pictures; a call that is not completed, or from an older log, has no facts", () => {
  const read = call({
    name: "Read",
    result: { read: { startLine: 20, numLines: 40, totalLines: 212 } },
  });
  expect(toolFacts(read).read).toEqual({ start: 20, count: 40, total: 212 });
  expect(toolFacts({ ...read, status: "failed" }).read).toBeUndefined();
  expect(
    toolFacts(call({ name: "Read", rawOutput: { type: "text", startLine: 1, numLines: 1 } })).read,
  ).toBeUndefined();
  expect(
    toolFacts(call({ name: "Glob", result: { search: { files: 340, more: true } } })).search,
  ).toEqual({
    files: 340,
    more: true,
  });
  expect(
    toolFacts(call({ name: "Grep", result: { search: { files: 2, matches: 5 } } })).search,
  ).toEqual({
    files: 2,
    matches: 5,
    more: false,
  });
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  expect(
    toolFacts(call({ name: "Read", content: [{ type: "content", content: image }] })).images,
  ).toEqual([{ key: "image-0", block: image }]);
});

test("facts follow what the agent sent, not the tool's name; the result stays through later updates", () => {
  const updates = [
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "x",
      name: "mcp__fs__search",
      status: "in_progress",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "x",
      status: "completed",
      _meta: { "cycle/toolResult": { search: { files: 3, more: true } } },
    },
    { sessionUpdate: "tool_call_update", toolCallId: "x", title: "later" },
  ] as unknown as SessionUpdate[];
  const conversation = updates.reduce((c, u) => applyUpdate(c, u), emptyConversation());
  const tool = conversation.items.find((item) => item.kind === "tool") as ToolItem;
  expect(toolFacts(tool).search).toEqual({ files: 3, more: true });
});

test("new content without counts clears the old ones; counts from the daemon are kept as they came", () => {
  const start = {
    sessionUpdate: "tool_call_update",
    toolCallId: "x",
    name: "Edit",
    status: "completed",
  };
  const toolAfter = (...updates: object[]) =>
    (updates as SessionUpdate[])
      .reduce((c, u) => applyUpdate(c, u), emptyConversation())
      .items.find((item) => item.kind === "tool") as ToolItem;
  const counted = {
    ...start,
    _meta: { "cycle/toolResult": { edit: { additions: 2, deletions: 1 } } },
  };
  expect(toolAfter(start, counted).result).toEqual({ edit: { additions: 2, deletions: 1 } });
  expect(toolAfter(start, counted, { ...start, content: [] }).result).toBeUndefined();
});

test("a page fetched has its status and size; links a call gave back are kept with their titles", () => {
  const fetched = call({ name: "WebFetch", result: { fetch: { status: 404, bytes: 1200 } } });
  expect(toolFacts(fetched).fetch).toEqual({ status: 404, bytes: 1200 });
  const searched = call({
    name: "WebSearch",
    content: [
      { type: "content", content: { type: "text", text: "notes" } },
      { type: "content", content: { type: "resource_link", uri: "https://bun.sh", name: "Bun" } },
      { type: "content", content: { type: "resource_link", uri: "https://x.dev", name: "" } },
    ],
  });
  expect(toolFacts(searched).links).toEqual([
    { key: "link-1", uri: "https://bun.sh", name: "Bun" },
    { key: "link-2", uri: "https://x.dev", name: "https://x.dev" },
  ]);
});
