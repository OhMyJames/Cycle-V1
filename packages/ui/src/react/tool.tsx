import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useEffect, useRef, useState } from "react";
import type { Block, ToolItem } from "../model/index.ts";
import { textOf } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import {
  CheckIcon,
  CloseIcon,
  FileEditIcon,
  FileReadIcon,
  type IconProps,
  SearchIcon,
  TerminalIcon,
  ToolIcon,
  WebIcon,
} from "./icons.tsx";

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

/** A line saying what a tool is doing, from what it was given. Shown, never run. */
export const toolSummary = (tool: ToolItem): string => {
  const input = (tool.rawInput ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) if (typeof input[key] === "string") return input[key] as string;
    return undefined;
  };
  return pick("command", "file_path", "path", "pattern", "url", "query", "description") ?? "";
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

/** The icon of a tool, by what it does. Unknown tools get the general one. */
export const TOOL_ICONS: Record<string, (props: IconProps) => React.ReactElement> = {
  Bash: TerminalIcon,
  Read: FileReadIcon,
  Edit: FileEditIcon,
  MultiEdit: FileEditIcon,
  Write: FileEditIcon,
  NotebookEdit: FileEditIcon,
  Grep: SearchIcon,
  Glob: SearchIcon,
  WebFetch: WebIcon,
  WebSearch: WebIcon,
};

/** How a tool call stands, as a shape (and the word beside it): done, failed, going, or not yet. */
export function ToolStatus({ status }: { status: string }) {
  if (status === "completed")
    return <CheckIcon size={14} data-slot="tool-mark" data-tone="success" />;
  if (status === "failed" || status === "cancelled")
    return <CloseIcon size={14} data-slot="tool-mark" data-tone="danger" />;
  if (status === "in_progress") return <span data-slot="spinner" aria-hidden="true" />;
  return <span data-slot="dot" data-tone="muted" data-shape="ring" aria-hidden="true" />;
}

export function ToolCard({ tool }: { tool: ToolItem }) {
  const { t } = useI18n();
  const status = tool.status ?? "pending";
  const [open, setOpen] = useOpenOnFailure(status === "failed");
  const output =
    tool.content.length > 0
      ? textOf(tool.content.flatMap((c) => (c.type === "content" ? [c.content as Block] : [c])))
      : stringify(tool.rawOutput);
  const summary = toolSummary(tool);
  const Icon = TOOL_ICONS[tool.name ?? ""] ?? ToolIcon;
  return (
    // A failure is what the person came to read: it starts open.
    <Collapsible data-kind="tool" data-status={status} open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger>
        <Icon size={14} data-slot="tool-icon" />
        <span data-slot="tool-name">{tool.name ?? t("tool.unnamed")}</span>
        <span data-slot="tool-summary">{summary}</span>
        <ToolStatus status={status} />
        <span data-slot="tool-status">{statusWord(t, status)}</span>
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
