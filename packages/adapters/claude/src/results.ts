// What a finished tool call says, in ACP's own fields, for the tools whose result the SDK also gives as structured data
// (`tool_use_result`): an edit as a `diff` of this one call, a read with the lines it read, a search with how much it
// found. The structured data itself never goes on: it holds whole files (`originalFile`, `content`, `base64`).
// What goes in `rawOutput` is a few counts and words, no contents; it is free-form in ACP, and a client that does not
// know it shows the text as before. docs/conversation-content.md has the table this follows.

type Json = Record<string, unknown>;

/** ACP v2 tool call content, as far as this file makes it. */
export type Content =
  | {
      type: "content";
      content: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
    }
  | {
      type: "diff";
      changes: { operation: "add" | "modify"; path: string }[];
      patch?: { format: "git_patch"; text: string } | null;
    };

export type Result = {
  content: Content[];
  rawOutput: unknown;
  locations?: { path: string; line?: number }[];
};

type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const hunksOf = (value: unknown): Hunk[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const hunks: Hunk[] = [];
  for (const hunk of value) {
    if (!isObject(hunk) || !Array.isArray(hunk.lines)) return undefined;
    const [oldStart, oldLines, newStart, newLines] = [
      num(hunk.oldStart),
      num(hunk.oldLines),
      num(hunk.newStart),
      num(hunk.newLines),
    ];
    if (
      oldStart === undefined ||
      oldLines === undefined ||
      newStart === undefined ||
      newLines === undefined
    )
      return undefined;
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunk.lines.map(String) });
  }
  return hunks;
};

/** A patch bigger than this is not sent: the counts and the path still are. A file written whole can be any size. */
export const MAX_PATCH = 100_000;

const header = (path: string, created: boolean): string => {
  const at = path.startsWith("/") ? path : `/${path}`;
  return [`diff --git a${at} b${at}`, created ? "--- /dev/null" : `--- a${at}`, `+++ b${at}`].join(
    "\n",
  );
};

/** The patch of hunks, in git's form, and how many lines it adds and takes away. */
const patchOf = (path: string, hunks: Hunk[], created: boolean) => {
  let additions = 0;
  let deletions = 0;
  const parts = [header(path, created)];
  for (const hunk of hunks) {
    parts.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
      parts.push(line);
    }
  }
  const text = `${parts.join("\n")}\n`;
  return { text, additions, deletions };
};

/** A new file as one hunk of added lines. */
const created = (content: string): Hunk[] => {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((l) => `+${l}`),
    },
  ];
};

const diff = (path: string, hunks: Hunk[], create: boolean, extra: Json): Result => {
  const patch = patchOf(path, hunks, create);
  const first = hunks[0];
  return {
    content: [
      {
        type: "diff",
        changes: [{ operation: create ? "add" : "modify", path }],
        patch:
          hunks.length > 0 && patch.text.length <= MAX_PATCH
            ? { format: "git_patch", text: patch.text }
            : null,
      },
    ],
    rawOutput: { ...extra, additions: patch.additions, deletions: patch.deletions },
    locations: [
      first !== undefined && !create ? { path, line: Math.max(1, first.newStart) } : { path },
    ],
  };
};

const edit = (out: Json): Result | undefined => {
  const hunks = hunksOf(out.structuredPatch);
  if (typeof out.filePath !== "string" || hunks === undefined) return undefined;
  return diff(out.filePath, hunks, false, { type: "update", ...staged(out) });
};

/** Held for the machine's owner to review, not written: the file is as it was. */
const staged = (out: Json): Json => (out.staged === true ? { staged: true } : {});

const write = (out: Json): Result | undefined => {
  if (typeof out.filePath !== "string" || (out.type !== "create" && out.type !== "update"))
    return undefined;
  if (out.type === "create") {
    if (typeof out.content !== "string") return undefined;
    return diff(out.filePath, created(out.content), true, { type: "create", ...staged(out) });
  }
  const hunks = hunksOf(out.structuredPatch);
  return hunks === undefined
    ? undefined
    : diff(out.filePath, hunks, false, { type: "update", ...staged(out) });
};

/** One cell's source before and after, as one hunk: a cell has no line numbers in the file worth giving. */
const notebook = (out: Json): Result | undefined => {
  if (typeof out.notebook_path !== "string" || typeof out.new_source !== "string") return undefined;
  const split = (text: string) => (text === "" ? [] : text.split("\n"));
  const before = split(typeof out.old_source === "string" ? out.old_source : "");
  const after = split(out.new_source);
  const hunk: Hunk = {
    oldStart: 1,
    oldLines: before.length,
    newStart: 1,
    newLines: after.length,
    lines: [...before.map((l) => `-${l}`), ...after.map((l) => `+${l}`)],
  };
  const result = diff(out.notebook_path, [hunk], false, { type: "update" });
  return { ...result, locations: [{ path: out.notebook_path }] };
};

const read = (out: Json, text: Content[]): Result | undefined => {
  const file = out.file;
  if (!isObject(file)) return undefined;
  if (out.type === "text") {
    const [startLine, numLines, totalLines] = [
      num(file.startLine),
      num(file.numLines),
      num(file.totalLines),
    ];
    if (typeof file.filePath !== "string" || startLine === undefined || numLines === undefined)
      return undefined;
    return {
      content: text,
      rawOutput: {
        type: "text",
        startLine,
        numLines,
        ...(totalLines !== undefined ? { totalLines } : {}),
      },
      locations: [{ path: file.filePath, line: Math.max(1, startLine) }],
    };
  }
  if (out.type === "image") {
    return {
      content: text,
      rawOutput: { type: "image", ...(num(file.originalSize) ? { bytes: file.originalSize } : {}) },
    };
  }
  return typeof out.type === "string"
    ? { content: text, rawOutput: { type: out.type } }
    : undefined;
};

const glob = (out: Json, text: Content[]): Result | undefined => {
  const numFiles = num(out.numFiles);
  if (numFiles === undefined) return undefined;
  const total = num(out.totalMatches);
  return {
    content: text,
    rawOutput: {
      numFiles,
      truncated: out.truncated === true,
      ...(total !== undefined ? { totalMatches: total } : {}),
    },
  };
};

const grep = (out: Json, text: Content[]): Result | undefined => {
  const numFiles = num(out.numFiles);
  if (numFiles === undefined) return undefined;
  const mode = out.mode === "content" || out.mode === "count" ? out.mode : "files_with_matches";
  const [numMatches, numLines] = [num(out.numMatches), num(out.numLines)];
  return {
    content: text,
    rawOutput: {
      mode,
      numFiles,
      ...(numMatches !== undefined ? { numMatches } : {}),
      ...(numLines !== undefined ? { numLines } : {}),
    },
  };
};

/**
 * A `tool_result`'s own content as ACP content: its text as one block, each image as an image. Every tool's result
 * goes through here, so a Read of a picture or an MCP tool's screenshot is no longer lost.
 */
export const contentOf = (content: unknown): Content[] => {
  if (typeof content === "string")
    return [{ type: "content", content: { type: "text", text: content } }];
  if (!Array.isArray(content)) {
    const text = content === undefined ? "" : JSON.stringify(content);
    return [{ type: "content", content: { type: "text", text } }];
  }
  const texts: string[] = [];
  const images: Content[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    if (part.type === "text") texts.push(String(part.text ?? ""));
    else if (part.type === "image" && isObject(part.source) && part.source.type === "base64") {
      const { data, media_type: mimeType } = part.source;
      if (
        typeof data === "string" &&
        typeof mimeType === "string" &&
        mimeType.startsWith("image/")
      ) {
        images.push({ type: "content", content: { type: "image", data, mimeType } });
      }
    } else if ("text" in part) texts.push(String(part.text));
  }
  const text: Content[] =
    texts.length > 0 || images.length === 0
      ? [{ type: "content", content: { type: "text", text: texts.join("") } }]
      : [];
  return [...text, ...images];
};

/**
 * What a finished call says, from its structured result when there is one this file knows; `undefined` leaves the
 * result as it was (its text). A failed call keeps its text: the message is what matters.
 */
export const resultOf = (
  name: string,
  structured: unknown,
  content: unknown,
): Result | undefined => {
  if (!isObject(structured)) return undefined;
  const text = contentOf(content);
  switch (name) {
    case "Edit":
      return edit(structured);
    case "Write":
      return write(structured);
    case "NotebookEdit":
      return notebook(structured);
    case "Read":
      return read(structured, text);
    case "Glob":
      return glob(structured, text);
    case "Grep":
      return grep(structured, text);
    default:
      return undefined;
  }
};
