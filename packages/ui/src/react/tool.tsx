import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useEffect, useRef, useState } from "react";
import type { Block, ToolItem } from "../model/index.ts";
import { activityOf, isLive, textOf } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon, CloseIcon } from "./icons.tsx";

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
  const input = (tool.rawInput ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) if (typeof input[key] === "string") return input[key] as string;
    return undefined;
  };
  return pick("command", "file_path", "notebook_path", "path", "pattern", "url", "query") ?? "";
};

/**
 * What the agent said the call is for, when it said ("Run the daemon tests"): a sentence of its own, easier to read than
 * the command it explains. Bash and Agent take one; any tool that does is read the same way.
 */
export const toolDescription = (tool: ToolItem): string | undefined => {
  const description = ((tool.rawInput ?? {}) as Record<string, unknown>).description;
  return typeof description === "string" && description.trim() !== ""
    ? description.trim()
    : undefined;
};

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
export const toolVerb = (t: (key: string) => string, tool: ToolItem, going: boolean): string => {
  const activity = activityOf(tool);
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
  return (
    // A failure is what the person came to read: it starts open.
    <Collapsible data-kind="tool" data-status={status} open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger>
        <Lead mark={going && status === "in_progress" ? "going" : failed ? "failed" : "other"} />{" "}
        {/* Which tool it was is for a screen reader and the tooltip of the line; the words say what it did. With a
            description, that is the line (what it is for), and what it ran follows it, muted; else the verb in its tense. */}
        <span data-slot="visually-hidden">{tool.name ?? t("tool.unnamed")}</span>{" "}
        <span
          data-slot="tool-verb"
          data-prose={description !== undefined || undefined}
          title={tool.name}
        >
          {description ?? toolVerb(t, tool, going)}
        </span>{" "}
        <span data-slot="tool-summary">{summary}</span>{" "}
        <span data-slot={failed ? "tool-status" : "visually-hidden"}>{statusWord(t, status)}</span>{" "}
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {tool.rawInput !== undefined ? (
          <pre data-slot="tool-input">{clip(stringify(tool.rawInput))}</pre>
        ) : null}
        {output !== "" ? <pre data-slot="tool-output">{clip(output)}</pre> : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}
