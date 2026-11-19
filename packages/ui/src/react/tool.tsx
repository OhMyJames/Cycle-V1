import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useEffect, useRef, useState } from "react";
import type { Translator } from "../i18n.ts";
import type { Block, DiffLine, ToolFacts, ToolItem } from "../model/index.ts";
import { activityOf, isLive, streamsOf, toolFacts } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon, CloseIcon } from "./icons.tsx";
import { ImageBlockView } from "./image.tsx";
import { Markdown } from "./markdown.tsx";
import { useAppStore } from "./store-context.tsx";

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
  if (key !== undefined) return String((tool.rawInput as Record<string, unknown>)[key]);
  return questionsOf(tool)[0] ?? "";
};

/** The questions a call put to the person (Claude's AskUserQuestion), when its input has them. */
const questionsOf = (tool: ToolItem): string[] => {
  const questions = ((tool.rawInput ?? {}) as Record<string, unknown>).questions;
  return Array.isArray(questions)
    ? questions.flatMap((q) =>
        typeof (q as { question?: unknown })?.question === "string" ? [String(q.question)] : [],
      )
    : [];
};

/** A plan a call proposes (Claude's ExitPlanMode), when its input has one: shown as the document it is. */
const planOf = (tool: ToolItem): string | undefined => {
  const plan = ((tool.rawInput ?? {}) as Record<string, unknown>).plan;
  return typeof plan === "string" && plan.trim() !== "" ? plan : undefined;
};

const SUMMARY_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query"];

/** Which field of the input the line shows. */
const summaryKey = (tool: ToolItem): string | undefined => {
  const input = (tool.rawInput ?? {}) as Record<string, unknown>;
  return SUMMARY_KEYS.find((key) => typeof input[key] === "string");
};

/** The command a call ran, when its input has one: shown as a command, to read and copy, not as a field of JSON. */
const commandOf = (tool: ToolItem): string | undefined => {
  const input = tool.rawInput;
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" && command !== "" ? command : undefined;
};

/** Fields of a command's input the panel or the line already says: the command, what it is for, where it runs. */
const COMMAND_SAID = new Set(["command", "description", "run_in_background", "timeout"]);
const saidByCommand = (tool: ToolItem): boolean =>
  Object.keys(tool.rawInput as Record<string, unknown>).every((key) => COMMAND_SAID.has(key));

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
  // Said by what the input holds, not by the tool's name: a question put, a plan proposed.
  if (activity === "other" && questionsOf(tool).length > 0)
    return t(`tool.verb.ask.${going ? "live" : "done"}`);
  if (activity === "other" && planOf(tool) !== undefined)
    return t(`tool.verb.plan.${going ? "live" : "done"}`);
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
  const streams = streamsOf(tool);
  const output = tool.content.length > 0 ? streams.out : stringify(tool.rawOutput);
  const command = commandOf(tool);
  const plan = planOf(tool);
  const questions = questionsOf(tool);
  const subagent = tool.subagent;
  // A sub-agent that runs on after its call has returned is still going, but only one sent to the background does: a
  // foreground one whose call has ended (the turn was stopped, the agent went) has no end coming to say so.
  const working =
    (going && status === "in_progress") ||
    (subagent?.state === "running" && (going || subagent.background));
  const summary = toolSummary(tool);
  const description = toolDescription(tool);
  const facts = toolFacts(tool);
  // An edit's diff says what its input said (old and new strings, a whole file), and says it better.
  const diff = facts.edit?.lines;
  const input =
    facts.edit === undefined &&
    tool.rawInput !== undefined &&
    !saidByLine(tool) &&
    !(command !== undefined && saidByCommand(tool)) &&
    plan === undefined &&
    questions.length === 0
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
        <Lead mark={working ? "going" : failed ? "failed" : "other"} />{" "}
        {/* Which tool it was is for a screen reader and the tooltip of the line; the words say what it did. With a
            description, that is the line (what it is for), and what it ran follows it, muted; else the verb in its tense. */}
        <span data-slot="visually-hidden">{tool.name ?? t("tool.unnamed")}</span>{" "}
        <span data-slot="tool-verb" data-prose={description !== undefined || undefined} title={tip}>
          {description ?? toolVerb(t, tool, going, facts)}
        </span>{" "}
        <span
          data-slot="tool-summary"
          data-prose={questions.length > 0 || undefined}
          title={summaryTip}
        >
          {summary}
        </span>{" "}
        {subagent !== undefined ? <SubagentFacts subagent={subagent} /> : <Facts facts={facts} />}{" "}
        <span data-slot={failed ? "tool-status" : "visually-hidden"}>{statusWord(t, status)}</span>{" "}
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {command !== undefined ? <Copyable kind="command" text={command} /> : null}
        {plan !== undefined ? (
          <div data-slot="tool-plan">
            <Markdown text={plan} />
          </div>
        ) : null}
        {questions.length > 1 ? (
          <ol data-slot="tool-questions">
            {questions
              .map((question, index) => ({ question, key: `${index}:${question}` }))
              .map(({ question, key }) => (
                <li key={key}>{question}</li>
              ))}
          </ol>
        ) : null}
        {input !== undefined ? <pre data-slot="tool-input">{clip(stringify(input))}</pre> : null}
        {diff !== undefined ? <DiffView lines={diff} /> : null}
        {facts.edit !== undefined &&
        diff === undefined &&
        facts.edit.additions + facts.edit.deletions > 0 ? (
          <p data-slot="tool-note">{t("tool.diff.tooLarge")}</p>
        ) : null}
        {output !== "" ? <Copyable kind="output" text={output} /> : null}
        {streams.err !== "" ? <Copyable kind="stderr" text={streams.err} /> : null}
        {facts.images.map((image) => (
          <ImageBlockView key={image.key} block={image.block} from="agent" />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The numbers after a call's summary: what an edit changed, which lines a read read, what a search found. */
function Facts({ facts }: { facts: ToolFacts }) {
  const i18n = useI18n();
  const { t } = i18n;
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
  if (facts.run !== undefined) {
    const { interrupted, timedOutMs, background } = facts.run;
    const text = interrupted
      ? t("tool.facts.interrupted")
      : timedOutMs !== undefined
        ? t("tool.facts.timedOut", { duration: durationOf(i18n, timedOutMs) })
        : background
          ? t("tool.facts.background")
          : undefined;
    return text === undefined ? null : <span data-slot="tool-facts">{text}</span>;
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

/**
 * A length of time as people say it, each part a unit `Intl` writes in the person's language: "45 sec", "2 min",
 * "1 min, 30 sec".
 */
const durationOf = (
  { number, locale }: Pick<Translator, "number" | "locale">,
  ms: number,
): string => {
  const seconds = Math.round(ms / 1000);
  const unit = (value: number, of: "minute" | "second") =>
    number(value, { style: "unit", unit: of, unitDisplay: "short" });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return unit(seconds, "second");
  const parts =
    rest === 0 ? [unit(minutes, "minute")] : [unit(minutes, "minute"), unit(rest, "second")];
  return new Intl.ListFormat(locale, { style: "narrow", type: "unit" }).format(parts);
};

/** An output too long to draw keeps its end, where a command says how it went; what is left out is counted. */
const clipStart = (t: (key: string, params?: Record<string, number>) => string, text: string) =>
  text.length > MAX_SHOWN
    ? [
        t("tool.earlierCharacters", { count: text.length - MAX_SHOWN }),
        text.slice(-MAX_SHOWN),
      ].join("\n")
    : text;

/** How many lines of a long output are shown before it is opened whole: its end, where a command says how it went. */
const TAIL_LINES = 40;

/**
 * A command, an output or an output's errors: sunken, with a button to copy all of it. A long output shows its last
 * lines, and says how many more there are; one click shows the rest.
 */
function Copyable({ kind, text }: { kind: "command" | "output" | "stderr"; text: string }) {
  const { t } = useI18n();
  const store = useAppStore();
  const [whole, setWhole] = useState(false);
  // What the button says after a press: copied, or why not.
  const [copied, setCopied] = useState<"done" | "failed" | undefined>(undefined);
  const lines = kind === "command" ? [] : text.split("\n");
  const hidden = whole ? 0 : Math.max(0, lines.length - TAIL_LINES);
  const shown = hidden > 0 ? lines.slice(hidden).join("\n") : text;
  const label = t(`tool.copy.${kind}`);
  return (
    <div data-slot="tool-block" data-kind={kind}>
      <div data-slot="tool-block-head">
        <span data-slot="tool-block-label">{t(`tool.block.${kind}`)}</span>
        <button
          type="button"
          data-slot="tool-copy"
          aria-label={label}
          title={label}
          onClick={() => {
            void store.copyText(text).then((done) => {
              setCopied(done ? "done" : "failed");
              if (done)
                store.track("tool_copied", { part: kind === "command" ? "command" : "output" });
            });
          }}
          onBlur={() => setCopied(undefined)}
        >
          {copied === "done"
            ? t("tool.copied")
            : copied === "failed"
              ? t("tool.copyFailed")
              : t("tool.copy")}
        </button>
      </div>
      {hidden > 0 ? (
        <button
          type="button"
          data-slot="tool-more"
          onClick={() => {
            setWhole(true);
            store.track("tool_output_expanded", {});
          }}
        >
          {t("tool.more", { count: hidden })}
        </button>
      ) : null}
      <pre data-slot={kind === "command" ? "tool-command" : "tool-output"}>
        {kind === "command" ? clip(shown) : clipStart(t, shown)}
      </pre>
    </div>
  );
}

/**
 * What a sub-agent is doing, on the line of the call that started it: what it uses now (or the SDK's line on what it is
 * doing) while it runs, and how much it did when it is done.
 */
function SubagentFacts({ subagent }: { subagent: NonNullable<ToolItem["subagent"]> }) {
  const i18n = useI18n();
  const { t } = i18n;
  const parts: string[] = [];
  if (subagent.state === "running") {
    if (subagent.background) parts.push(t("tool.facts.background"));
    if (subagent.summary !== undefined) parts.push(subagent.summary);
    else if (subagent.lastTool !== undefined)
      parts.push(t("subagent.using", { tool: subagent.lastTool }));
  } else {
    parts.push(t(`subagent.${subagent.state}`));
    if (subagent.usage !== undefined && subagent.usage.toolUses > 0) {
      parts.push(t("subagent.steps", { count: subagent.usage.toolUses }));
    }
    if (subagent.usage !== undefined && subagent.usage.durationMs > 0) {
      parts.push(durationOf(i18n, subagent.usage.durationMs));
    }
  }
  const text = parts.join(" · ");
  return text === "" ? null : (
    <span data-slot="tool-facts" data-tone={subagent.state === "failed" ? "danger" : undefined}>
      {text}
    </span>
  );
}
