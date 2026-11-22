/**
 * The end of a reply that is still arriving, made fit to draw. Streamdown completes a mark that has text after it (`**bo`
 * draws bold), but two things still show as raw characters for the moment a batch sits there, and then change:
 * - A table, until its header and delimiter rows are both written: GFM reads it as a paragraph, so every `|` and `---` shows.
 *   The header row is held back until the delimiter row starts; a delimiter row being written is completed.
 * - A mark with nothing after it yet (`**`, `` ` ``, `~~`, `_`): remend completes a mark only once text follows it.
 *   It is held back.
 * Only the end is touched, never inside a code fence that is still open, and never a reply that has finished.
 * The rules are old-cycle's (`packages/ui/src/content/stream-mend.ts`, commit acd38e37); see
 * `.agents/notes/2026-11-22-conversation-markdown-rules.md`.
 */

// Any indent: a fence in a list item is indented past the three spaces a top-level one may have.
const FENCE = /^\s*(`{3,}|~{3,})/;

/** Whether the text ends inside a code fence that has not been closed. */
export const inOpenFence = (text: string): boolean => {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const fence = FENCE.exec(line)?.[1];
    if (fence === undefined) continue;
    if (open === undefined) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length && line.trim() === fence)
      open = undefined;
  }
  return open !== undefined;
};

const isRow = (line: string): boolean => line.trimStart().startsWith("|");
const isDelimiter = (line: string): boolean =>
  /^\s*\|?\s*:?-+:?\s*(\|\s*:?-*:?\s*)*\|?\s*$/.test(line);
const cellsOf = (row: string): number =>
  row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;

const mendTable = (text: string): string => {
  const lines = text.split("\n");
  const last = lines.at(-1) ?? "";
  const before = lines.at(-2);
  // A first row of a table, alone: it may be a header, and it is drawn once its delimiter row starts.
  if (isRow(last) && (before === undefined || !isRow(before))) return lines.slice(0, -1).join("\n");
  // Under a header, the row being written may be its delimiter row.
  if (
    before !== undefined &&
    isRow(before) &&
    (lines.at(-3) === undefined || !isRow(lines.at(-3) ?? ""))
  ) {
    // Started, with a dash: drawn whole, so the table is a table from now on.
    if (last.includes("-") && isDelimiter(last)) {
      const delimiter = `|${" --- |".repeat(cellsOf(before))}`;
      return [...lines.slice(0, -1), delimiter].join("\n");
    }
    // Only a pipe or a colon so far: the header waits with it.
    if (/^\s*\|[\s|:]*$/.test(last)) return lines.slice(0, -2).join("\n");
  }
  return text;
};

/** A mark at the very end with nothing after it: `**`, `__`, `*`, `_`, `~~` or `` ` `` after a space or a line's start. */
const BARE_MARK = /(^|\s)(\*{1,3}|_{1,3}|~~|`+)$/;

export const mendStreaming = (text: string): string => {
  if (inOpenFence(text)) return text;
  const table = mendTable(text);
  if (table !== text) return table;
  return text.replace(BARE_MARK, "$1");
};
