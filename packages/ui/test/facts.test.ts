import { expect, test } from "bun:test";
import type { ToolItem } from "../src/model/index.ts";
import { diffLines, toolFacts } from "../src/model/index.ts";

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
        rawOutput: { type: "create", additions: 9000, deletions: 0, staged: true },
      }),
    ).edit,
  ).toEqual({ created: true, additions: 9000, deletions: 0, staged: true });
  // No patch and no counts: nothing to say.
  expect(toolFacts(call({ name: "Write", content: [big] })).edit).toBeUndefined();
});

test("reads, searches and pictures; a call that is not completed, or from an older log, has no facts", () => {
  const read = call({
    name: "Read",
    rawOutput: { type: "text", startLine: 20, numLines: 40, totalLines: 212 },
  });
  expect(toolFacts(read).read).toEqual({ start: 20, count: 40, total: 212 });
  expect(toolFacts({ ...read, status: "failed" }).read).toBeUndefined();
  expect(toolFacts(call({ name: "Read", rawOutput: "    1\tline" })).read).toBeUndefined();
  expect(
    toolFacts(
      call({ name: "Glob", rawOutput: { numFiles: 100, truncated: true, totalMatches: 340 } }),
    ).search,
  ).toEqual({
    files: 340,
    more: true,
  });
  expect(
    toolFacts(call({ name: "Grep", rawOutput: { mode: "count", numFiles: 2, numMatches: 5 } }))
      .search,
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
