import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { contentOf, MAX_PATCH, resultOf } from "../src/results.ts";
import { TurnTranslator } from "../src/translate.ts";

// Shapes from the SDK's `sdk-tools.d.ts` (0.3.327): FileEditOutput, FileWriteOutput, FileReadOutput, GlobOutput,
// GrepOutput. No real session has been recorded yet (docs/conversation-content.md, "样本").

const call = (id: string, name: string, input: Record<string, unknown>) =>
  ({
    type: "assistant",
    message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] },
  }) as unknown as SDKMessage;

const result = (id: string, content: unknown, structured?: unknown, isError = false) =>
  ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
    tool_use_result: structured,
  }) as unknown as SDKMessage;

const run = (...messages: SDKMessage[]) => {
  const translator = new TurnTranslator();
  return messages.flatMap((m) => translator.feed(m)) as unknown as Record<string, unknown>[];
};

const EDIT = {
  filePath: "/repo/src/a.ts",
  oldString: "const a = 1;",
  newString: "const a = 2;\nconst b = 3;",
  originalFile: "SECRET WHOLE FILE",
  structuredPatch: [
    {
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4,
      lines: [" x", "-const a = 1;", "+const a = 2;", "+const b = 3;", " y"],
    },
  ],
  userModified: false,
  replaceAll: false,
};

test("an edit becomes the diff of that one call, with its counts and where it is; the whole file never goes on", () => {
  const updates = run(
    call("e", "Edit", { file_path: "/repo/src/a.ts", old_string: "o", new_string: "n" }),
    result(
      "e",
      "The file /repo/src/a.ts has been updated. Here's the result of running `cat -n`…",
      EDIT,
    ),
  );
  expect(updates[0]).toMatchObject({
    status: "in_progress",
    locations: [{ path: "/repo/src/a.ts" }],
  });
  const done = updates[1] ?? {};
  expect(done.status).toBe("completed");
  expect(done.content).toEqual([
    {
      type: "diff",
      changes: [{ operation: "modify", path: "/repo/src/a.ts" }],
      patch: {
        format: "git_patch",
        text: [
          "diff --git a/repo/src/a.ts b/repo/src/a.ts",
          "--- a/repo/src/a.ts",
          "+++ b/repo/src/a.ts",
          "@@ -10,3 +10,4 @@",
          " x",
          "-const a = 1;",
          "+const a = 2;",
          "+const b = 3;",
          " y",
          "",
        ].join("\n"),
      },
    },
  ]);
  expect(done.rawOutput).toEqual({ type: "update", additions: 2, deletions: 1 });
  expect(done.locations).toEqual([{ path: "/repo/src/a.ts", line: 10 }]);
  expect(JSON.stringify(updates)).not.toContain("SECRET WHOLE FILE");
});

test("a new file is all added lines; a huge one keeps its counts and drops the patch", () => {
  const [, made] = run(
    call("w", "Write", { file_path: "/repo/new.md", content: "a\nb\n" }),
    result("w", "File created", {
      type: "create",
      filePath: "/repo/new.md",
      content: "a\nb\n",
      structuredPatch: [],
      originalFile: null,
    }),
  );
  expect(made?.content).toEqual([
    {
      type: "diff",
      changes: [{ operation: "add", path: "/repo/new.md" }],
      patch: {
        format: "git_patch",
        text: "diff --git a/repo/new.md b/repo/new.md\n--- /dev/null\n+++ b/repo/new.md\n@@ -0,0 +1,2 @@\n+a\n+b\n",
      },
    },
  ]);
  expect(made?.rawOutput).toEqual({ type: "create", additions: 2, deletions: 0 });

  const big = `${"x".repeat(99)}\n`.repeat(MAX_PATCH / 100 + 10);
  const [, huge] = run(
    call("w", "Write", { file_path: "/repo/big.txt", content: big }),
    result("w", "File created", {
      type: "create",
      filePath: "/repo/big.txt",
      content: big,
      structuredPatch: [],
      originalFile: null,
    }),
  );
  const [change] = (huge?.content ?? []) as { patch: unknown }[];
  expect(change?.patch).toBeNull();
  expect(huge?.rawOutput).toEqual({
    type: "create",
    additions: MAX_PATCH / 100 + 10,
    deletions: 0,
  });
});

test("an edit held for review says so", () => {
  const [, held] = run(
    call("e", "Edit", { file_path: "/repo/src/a.ts" }),
    result("e", "held", { ...EDIT, staged: true }),
  );
  expect(held?.rawOutput).toMatchObject({ staged: true });
});

test("a read keeps its text and says which lines it read", () => {
  const updates = run(
    call("r", "Read", { file_path: "/repo/a.ts", offset: 20, limit: 2 }),
    result("r", "    20\tone\n    21\ttwo", {
      type: "text",
      file: {
        filePath: "/repo/a.ts",
        content: "one\ntwo",
        numLines: 2,
        startLine: 20,
        totalLines: 300,
      },
    }),
  );
  expect(updates[0]).toMatchObject({ locations: [{ path: "/repo/a.ts", line: 20 }] });
  expect(updates[1]).toMatchObject({
    content: [{ type: "content", content: { type: "text", text: "    20\tone\n    21\ttwo" } }],
    rawOutput: { type: "text", startLine: 20, numLines: 2, totalLines: 300 },
    locations: [{ path: "/repo/a.ts", line: 20 }],
  });
});

test("a read picture comes through as an image; its bytes are not repeated in rawOutput", () => {
  const [, read] = run(
    call("r", "Read", { file_path: "/repo/a.png" }),
    result(
      "r",
      [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }],
      {
        type: "image",
        file: { base64: "iVBOR", type: "image/png", originalSize: 1234 },
      },
    ),
  );
  expect(read?.content).toEqual([
    { type: "content", content: { type: "image", data: "iVBOR", mimeType: "image/png" } },
  ]);
  expect(read?.rawOutput).toEqual({ type: "image", bytes: 1234 });
});

test("searches say how much they found", () => {
  const [, glob] = run(
    call("g", "Glob", { pattern: "**/*.ts" }),
    result("g", "a.ts\nb.ts", {
      durationMs: 3,
      numFiles: 2,
      filenames: ["a.ts", "b.ts"],
      truncated: false,
    }),
  );
  expect(glob?.rawOutput).toEqual({ numFiles: 2, truncated: false });
  const [, grep] = run(
    call("s", "Grep", { pattern: "todo", output_mode: "content" }),
    result("s", "a.ts:1:todo", {
      mode: "content",
      numFiles: 1,
      filenames: [],
      content: "a.ts:1:todo",
      numLines: 1,
    }),
  );
  expect(grep?.rawOutput).toEqual({ mode: "content", numFiles: 1, numLines: 1 });
});

test("a failed call, an unknown shape, or a message with two results keeps the text as it came", () => {
  const [, failed] = run(call("e", "Edit", {}), result("e", "String not found", EDIT, true));
  expect(failed).toMatchObject({
    status: "failed",
    content: [{ type: "content", content: { type: "text", text: "String not found" } }],
    rawOutput: "String not found",
  });
  const [, odd] = run(call("e", "Edit", {}), result("e", "ok", { filePath: 3 }));
  expect(odd?.rawOutput).toBe("ok");

  const translator = new TurnTranslator();
  translator.feed(call("a", "Read", { file_path: "/a" }));
  translator.feed(call("b", "Read", { file_path: "/b" }));
  const both = translator.feed({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "a", content: "A" },
        { type: "tool_result", tool_use_id: "b", content: "B" },
      ],
    },
    tool_use_result: {
      type: "text",
      file: { filePath: "/a", content: "A", numLines: 1, startLine: 1 },
    },
  } as unknown as SDKMessage) as unknown as Record<string, unknown>[];
  expect(both.map((u) => u.rawOutput)).toEqual(["A", "B"]);
});

test("a tool result's text parts join and its images follow; a picture alone has no empty text", () => {
  expect(
    contentOf([
      { type: "text", text: "a" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "J" } },
      { type: "text", text: "b" },
    ]),
  ).toEqual([
    { type: "content", content: { type: "text", text: "ab" } },
    { type: "content", content: { type: "image", data: "J", mimeType: "image/jpeg" } },
  ]);
  expect(contentOf([{ type: "image", source: { type: "url", url: "http://x" } }])).toEqual([
    { type: "content", content: { type: "text", text: "" } },
  ]);
  expect(resultOf("Bash", { stdout: "x" }, "x")).toBeUndefined();
});
