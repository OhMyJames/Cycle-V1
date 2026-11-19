import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useEffect, useRef, useState } from "react";
import type { Block, DiffLine, ToolFacts, ToolItem } from "../model/index.ts";
import { activityOf, isLive, textOf, toolFacts } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon, CloseIcon } from "./icons.tsx";
import { ImageBlockView } from "./image.tsx";

/**
 * Whether a card or row is open: it starts open when it holds a failure (that is what the person came to read), opens by
 * itself when a failure arrives while it is on screen, and after that follows the person's own clicks.
 */
export function useOpenOnFailure(failed: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(failed);
  const was = useRef(failed);
  useEffect(() => {
    if (failed && !was.current) setOpen(true);
    was.current = failed;
  }, [failed]);
  return [open, setOpen];
}

/** The status words a tool call has in the catalog; any other is shown as it came. */
const STATUS_WORDS = new Set([
  "pending",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export const statusWord = (t: (key: string) => string, status: string): string =>
  STATUS_WORDS.has(status) ? t(`tool.status.${status}`) : status.replace("_", " ");

const MAX_SHOWN = 20_000;

const clip = (text: string): string =>
  text.length > MAX_SHOWN
    ? `${text.slice(0, MAX_SHOWN)}\n… (${text.length - MAX_SHOWN} more characters not shown)`
    : text;

/** What a call acted on: its command, path, pattern, address or query. Shown, never run. */
export const toolSummary = (tool: ToolItem): string => {
  const key = summaryKey(tool);
  return key === undefined ? "" : String((tool.rawInput as Record<string, unknown>)[key]);
};

const SUMMARY_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query"];

/** Which field of the input the line shows. */
const summaryKey = (tool: ToolItem): string | undefined => {
  const input = (tool.rawInput ?? {}) as Record<string, unknown>;
  return SUMMARY_KEYS.find((key) => typeof input[key] === "string");
};

/** An input with nothing in it the line does not already say (a Read of a path): not shown again when opened. */
const saidByLine = (tool: ToolItem): boolean => {
  const input = tool.rawInput;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const key = summaryKey(tool);
  return Object.keys(input).every((k) => k === key);
};

/**
 * What the agent said the call is for, when it said ("Run the daemon tests"): a sentence of its own, easier to read than
 * the command it explains. Bash, Monitor and Agent take one.
 */
export const toolDescription = (tool: ToolItem): string | undefined => {
  // Only where the field is that sentence: an MCP tool's `description` is often content (an issue's body), not a purpose.
  if (!PURPOSE_TOOLS.has(tool.name ?? "")) return undefined;
  const description = ((tool.rawInput ?? {}) as Record<string, unknown>).description;
  if (typeof description !== "string") return undefined;
  const line = description.trim();
  // A sentence, not a document: one line, of a length a line can hold.
  return line !== "" && !line.includes("\n") && line.length <= 160 ? line : undefined;
};

/** The tools whose `description` is the agent's sentence for what the call is for. */
const PURPOSE_TOOLS: ReadonlySet<string> = new Set(["Bash", "Monitor", "Agent", "Task"]);

const stringify = (value: unknown): string => {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/**
 * What a call did, as a verb in its tense: "Running" while it goes, "Ran" once it has. A tool with no verb of its own is
 * named instead.
 */
export const toolVerb = (
  t: (key: string) => string,
  tool: ToolItem,
  going: boolean,
  facts?: ToolFacts,
): string => {
  const activity = activityOf(tool);
  if (!going && (facts ?? toolFacts(tool)).edit?.created === true)
    return t("tool.verb.create.done");
  if (activity === "other") return tool.name ?? t("tool.unnamed");
  return t(`tool.verb.${activity}.${going ? "live" : "done"}`);
};

/**
 * What leads a line, for a call or a stretch of them: the spinner while it goes, a cross when it failed, else a small dot.
 * Not the tool's icon: the words already say what it did ("Ran", "Read"), and a state is what the eye looks for down the
 * left edge. The one place a status becomes a mark.
 */
export function Lead({ mark }: { mark: "going" | "failed" | "other" }) {
  return (
    <span data-slot="tool-lead">
      {mark === "going" ? (
        <span data-slot="spinner" aria-hidden="true" />
      ) : mark === "failed" ? (
        <CloseIcon size={14} data-slot="tool-mark" data-tone="danger" />
      ) : (
        <span data-slot="tool-dot" aria-hidden="true" />
      )}
    </span>
  );
}

/**
 * One call, as one quiet line: what it did and on what. The verb's tense says whether it is going; a failure says so in
 * a word as well as in red. It opens to what it was given and what came back.
 */
export function ToolCard({ tool }: { tool: ToolItem }) {
  const { t } = useI18n();
  const status = tool.status ?? "pending";
  const failed = status === "failed" || status === "cancelled";
  // The model ends a turn's calls when the turn ends (cancelled), so one that is live is going.
  const going = isLive(tool);
  const [open, setOpen] = useOpenOnFailure(status === "failed");
  const output =
    tool.content.length > 0
      ? textOf(tool.content.flatMap((c) => (c.type === "content" ? [c.content as Block] : [c])))
      : stringify(tool.rawOutput);
  const summary = toolSummary(tool);
  const description = toolDescription(tool);
  const facts = toolFacts(tool);
  // An edit's diff says what its input said (old and new strings, a whole file), and says it better.
  const diff = facts.edit?.lines;
  const input =
    facts.edit === undefined && tool.rawInput !== undefined && !saidByLine(tool)
      ? tool.rawInput
      : undefined;
  // The tooltip names the tool, and holds the whole sentence when the line cuts it.
  const tip =
    description !== undefined ? [tool.name, description].filter(Boolean).join(": ") : tool.name;
  const summaryTip = summary || undefined;
  return (
    // A failure is what the person came to read: it starts open.
    <Collapsible data-kind="tool" data-status={status} open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger>
        <Lead mark={going && status === "in_progress" ? "going" : failed ? "failed" : "other"} />{" "}
        {/* Which tool it was is for a screen reader and the tooltip of the line; the words say what it did. With a
            description, that is the line (what it is for), and what it ran follows it, muted; else the verb in its tense. */}
        <span data-slot="visually-hidden">{tool.name ?? t("tool.unnamed")}</span>{" "}
        <span data-slot="tool-verb" data-prose={description !== undefined || undefined} title={tip}>
          {description ?? toolVerb(t, tool, going, facts)}
        </span>{" "}
        <span data-slot="tool-summary" title={summaryTip}>
          {summary}
        </span>{" "}
        <Facts facts={facts} />{" "}
        <span data-slot={failed ? "tool-status" : "visually-hidden"}>{statusWord(t, status)}</span>{" "}
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {input !== undefined ? <pre data-slot="tool-input">{clip(stringify(input))}</pre> : null}
        {diff !== undefined ? <DiffView lines={diff} /> : null}
        {facts.edit !== undefined &&
        diff === undefined &&
        facts.edit.additions + facts.edit.deletions > 0 ? (
          <p data-slot="tool-note">{t("tool.diff.tooLarge")}</p>
        ) : null}
        {output !== "" ? <pre data-slot="tool-output">{clip(output)}</pre> : null}
        {facts.images.map((image) => (
          <ImageBlockView key={image.key} block={image.block} from="agent" />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The numbers after a call's summary: what an edit changed, which lines a read read, what a search found. */
function Facts({ facts }: { facts: ToolFacts }) {
  const { t } = useI18n();
  const { edit, read, search } = facts;
  if (edit !== undefined) {
    const label = t("tool.facts.diff", { added: edit.additions, removed: edit.deletions });
    const counted = edit.additions + edit.deletions > 0;
    const empty = edit.created && edit.additions === 0;
    const tip = counted ? label : undefined;
    return (
      <span data-slot="tool-facts" title={tip}>
        {empty ? t("tool.facts.empty") : null}
        {counted ? (
          <>
            {edit.additions > 0 ? (
              <span data-tone="add">{t("tool.facts.added", { count: edit.additions })}</span>
            ) : null}
            {edit.additions > 0 && edit.deletions > 0 ? " " : null}
            {edit.deletions > 0 ? (
              <span data-tone="del">{t("tool.facts.removed", { count: edit.deletions })}</span>
            ) : null}
            <span data-slot="visually-hidden">{label}</span>
          </>
        ) : null}
        {/* Held for review: the file is as it was, whatever the counts say. */}
        {edit.staged ? (
          <>
            {empty || counted ? " " : null}
            <span>{t("tool.facts.staged")}</span>
          </>
        ) : null}
      </span>
    );
  }
  if (read !== undefined) {
    // Past the end of the file (or an empty one): no lines were read, and there is no range to give.
    if (read.count === 0)
      return <span data-slot="tool-facts">{t("tool.facts.lines", { count: 0 })}</span>;
    const whole = read.start === 1 && read.total !== undefined && read.count >= read.total;
    const end = read.start + Math.max(0, read.count - 1);
    const text = whole
      ? t("tool.facts.lines", { count: read.count })
      : read.total !== undefined
        ? t("tool.facts.rangeOf", { start: read.start, end, total: read.total })
        : t("tool.facts.range", { start: read.start, end });
    return <span data-slot="tool-facts">{text}</span>;
  }
  if (search !== undefined) {
    const files = search.more
      ? t("tool.facts.filesMore", { count: search.files })
      : t("tool.facts.files", { count: search.files });
    const text =
      search.matches !== undefined
        ? t("tool.facts.matchesIn", { count: search.matches, files })
        : search.lines !== undefined
          ? t("tool.facts.lines", { count: search.lines })
          : files;
    return <span data-slot="tool-facts">{text}</span>;
  }
  return null;
}

/** The most lines of one diff drawn; the rest are counted. */
const MAX_DIFF_LINES = 400;

/** One call's change, line by line: removed and added lines marked, and numbered as in the file. */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  const { t } = useI18n();
  // The first hunk's marker says only that the change starts somewhere: its numbers say where. Between hunks it marks the gap.
  const shown = (lines[0]?.kind === "hunk" ? lines.slice(1) : lines).slice(0, MAX_DIFF_LINES);
  const rest =
    lines.filter((line) => line.kind !== "hunk").length -
    shown.filter((line) => line.kind !== "hunk").length;
  return (
    <div data-slot="tool-diff">
      {shown.map((line) => (
        <div key={line.id} data-line={line.kind}>
          <span data-slot="diff-number" aria-hidden="true">
            {line.line ?? ""}
          </span>
          <span data-slot="diff-sign" aria-hidden="true">
            {SIGNS[line.kind]}
          </span>
          {line.kind !== "hunk" ? (
            <span data-slot="visually-hidden">{t(`tool.diff.${line.kind}`)}</span>
          ) : null}
          <span data-slot="diff-text">{line.kind === "hunk" ? "" : line.text}</span>
        </div>
      ))}
      {rest > 0 ? <p data-slot="tool-note">{t("tool.diff.more", { count: rest })}</p> : null}
    </div>
  );
}

const SIGNS: Record<DiffLine["kind"], string> = { add: "+", del: "−", context: "", hunk: "⋯" };
