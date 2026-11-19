// What a finished file tool call amounts to, for its line: the edit it made, the lines it read, how much a search found.
// Read from ACP's own fields: a `diff` in the content, and the few counts the Claude adapter puts in `rawOutput`
// (docs/conversation-content.md). Each is optional: a call from an older log, or from another agent, has none of them,
// and its line stays as it was.
import type { Block, ToolItem } from "./conversation.ts";

/** A line of a diff to draw, with its number: in the new file, or for a removed line in the old one. */
export type DiffLine = {
  kind: "add" | "del" | "context" | "hunk";
  text: string;
  line?: number;
  /** Unique in its diff, for a list's key: the same text can be on two lines. */
  id: string;
};

export type ToolFacts = {
  /** The change this call made: its own lines, not the file's whole history. */
  edit?: {
    created: boolean;
    additions: number;
    deletions: number;
    /** The patch as lines to draw; absent when the agent sent only the counts (a very large file). */
    lines?: DiffLine[];
    /** Held for review instead of written: the file is as it was. */
    staged: boolean;
  };
  /** A read of part of a file: its first line, how many, and of how many. */
  read?: { start: number; count: number; total?: number };
  /** A search: files found, and matches or lines where it counted them. */
  search?: { files: number; matches?: number; lines?: number; more: boolean };
  /** Pictures in the result (a Read of an image, an MCP screenshot), each with a key for its list. */
  images: { key: string; block: Block }[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The lines of a git patch to draw: the hunks, without the file headers above the first. */
export const diffLines = (patch: string): DiffLine[] => {
  const lines: DiffLine[] = [];
  let inHunk = false;
  let before = 0;
  let after = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      inHunk = true;
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      lines.push({ kind: "hunk", text: line, id: `h${lines.length}` });
      continue;
    }
    if (!inHunk) continue;
    const at = lines.length;
    if (line.startsWith("+")) {
      lines.push({ kind: "add", text: line.slice(1), line: after, id: `a${at}` });
      after++;
    } else if (line.startsWith("-")) {
      lines.push({ kind: "del", text: line.slice(1), line: before, id: `d${at}` });
      before++;
    } else if (line.startsWith(" ")) {
      lines.push({ kind: "context", text: line.slice(1), line: after, id: `c${at}` });
      before++;
      after++;
    }
  }
  return lines;
};

const editOf = (tool: ToolItem): ToolFacts["edit"] => {
  const diff = tool.content.find((block) => block.type === "diff");
  if (diff === undefined) return undefined;
  const changes = Array.isArray(diff.changes) ? diff.changes : [];
  const created = changes.some((change) => isObject(change) && change.operation === "add");
  const patch =
    isObject(diff.patch) && typeof diff.patch.text === "string" ? diff.patch.text : undefined;
  const lines = patch !== undefined ? diffLines(patch) : undefined;
  const raw = isObject(tool.rawOutput) ? tool.rawOutput : {};
  const additions = num(raw.additions) ?? lines?.filter((l) => l.kind === "add").length;
  const deletions = num(raw.deletions) ?? lines?.filter((l) => l.kind === "del").length;
  if (additions === undefined || deletions === undefined) return undefined;
  return {
    created,
    additions,
    deletions,
    ...(lines !== undefined ? { lines } : {}),
    staged: raw.staged === true,
  };
};

const readOf = (tool: ToolItem): ToolFacts["read"] => {
  const raw = tool.rawOutput;
  if (!isObject(raw) || raw.type !== "text") return undefined;
  const [start, count, total] = [num(raw.startLine), num(raw.numLines), num(raw.totalLines)];
  if (start === undefined || count === undefined) return undefined;
  return { start: Math.max(1, start), count, ...(total !== undefined ? { total } : {}) };
};

const searchOf = (tool: ToolItem): ToolFacts["search"] => {
  const raw = tool.rawOutput;
  if (!isObject(raw)) return undefined;
  const files = num(raw.numFiles);
  if (files === undefined) return undefined;
  const [matches, lines] = [num(raw.numMatches), num(raw.numLines)];
  return {
    files: tool.name === "Glob" ? (num(raw.totalMatches) ?? files) : files,
    ...(matches !== undefined && raw.mode === "count" ? { matches } : {}),
    ...(lines !== undefined && raw.mode === "content" ? { lines } : {}),
    more: raw.truncated === true,
  };
};

/** The facts of a call. Only a completed call has them: a failed one's text is what it says. */
export const toolFacts = (tool: ToolItem): ToolFacts => {
  const images: ToolFacts["images"] = [];
  for (const [index, block] of tool.content.entries()) {
    const inner =
      block.type === "content" && isObject(block.content) ? (block.content as Block) : block;
    if (inner.type === "image") images.push({ key: `image-${index}`, block: inner });
  }
  if (tool.status !== "completed") return { images };
  const facts: ToolFacts = { images };
  const edit = editOf(tool);
  if (edit !== undefined) facts.edit = edit;
  if (tool.name === "Read") {
    const read = readOf(tool);
    if (read !== undefined) facts.read = read;
  }
  if (tool.name === "Glob" || tool.name === "Grep") {
    const search = searchOf(tool);
    if (search !== undefined) facts.search = search;
  }
  return facts;
};
