import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useEffect, useRef } from "react";
import type { Block, Conversation, Item, ToolItem } from "../model/index.ts";
import { textOf } from "../model/index.ts";
import {
  CheckIcon,
  CloseIcon,
  ErrorCircleIcon,
  FileEditIcon,
  FileReadIcon,
  type IconProps,
  SearchIcon,
  TerminalIcon,
  ThoughtIcon,
  ToolIcon,
  WebIcon,
} from "./icons.tsx";
import { Markdown } from "./markdown.tsx";

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

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks
        .map((block, index) => ({ block, key: `${block.type}-${index}` }))
        .map(({ block, key }) =>
          block.type === "text" ? (
            <span key={key}>{String(block.text)}</span>
          ) : (
            <span data-slot="block-note" key={key}>
              [{block.type}]
            </span>
          ),
        )}
    </>
  );
}

/** The icon of a tool, by what it does. Unknown tools get the general one. */
const TOOL_ICONS: Record<string, (props: IconProps) => React.ReactElement> = {
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
function ToolStatus({ status }: { status: string }) {
  if (status === "completed")
    return <CheckIcon size={14} data-slot="tool-mark" data-tone="success" />;
  if (status === "failed" || status === "cancelled")
    return <CloseIcon size={14} data-slot="tool-mark" data-tone="danger" />;
  if (status === "in_progress") return <span data-slot="spinner" aria-hidden="true" />;
  return <span data-slot="dot" data-tone="muted" data-shape="ring" aria-hidden="true" />;
}

function ToolCard({ tool }: { tool: ToolItem }) {
  const status = tool.status ?? "pending";
  const output =
    tool.content.length > 0
      ? textOf(tool.content.flatMap((c) => (c.type === "content" ? [c.content as Block] : [c])))
      : stringify(tool.rawOutput);
  const summary = toolSummary(tool);
  const Icon = TOOL_ICONS[tool.name ?? ""] ?? ToolIcon;
  return (
    // A failure is what the person came to read: it starts open.
    <Collapsible data-slot="tool" data-status={status} defaultOpen={status === "failed"}>
      <CollapsibleTrigger>
        <Icon size={14} data-slot="tool-icon" />
        <span data-slot="tool-name">{tool.name ?? "Tool"}</span>
        <span data-slot="tool-summary">{summary}</span>
        <ToolStatus status={status} />
        <span data-slot="tool-status">{status.replace("_", " ")}</span>
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

function ItemView({ item, streaming }: { item: Item; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div data-slot="message" data-role="user">
          <Blocks blocks={item.blocks} />
        </div>
      );
    case "agent":
      return (
        <div data-slot="message" data-role="agent">
          <Markdown text={textOf(item.blocks)} streaming={streaming} />
        </div>
      );
    case "thought":
      return (
        <Collapsible data-slot="thought">
          <CollapsibleTrigger>
            <ThoughtIcon size={14} />
            Thinking
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div data-slot="thought-text">{textOf(item.blocks)}</div>
          </CollapsiblePanel>
        </Collapsible>
      );
    case "tool":
      return <ToolCard tool={item} />;
    case "plan":
      return (
        <ol data-slot="plan" aria-label="Plan">
          {item.entries
            .map((entry, index) => ({ entry, key: `${index}:${entry.content}` }))
            .map(({ entry, key }) => (
              <li key={key} data-status={entry.status}>
                <span data-slot="plan-mark" data-status={entry.status} aria-hidden="true">
                  {entry.status === "completed" ? <CheckIcon size={12} /> : null}
                </span>
                <span>{entry.content}</span>
                <span data-slot="visually-hidden">{entry.status.replace("_", " ")}</span>
              </li>
            ))}
        </ol>
      );
    case "notice":
      return (
        <div data-slot="notice" data-severity={item.severity} role="status">
          {item.severity === "error" ? <ErrorCircleIcon size={14} /> : null}
          {item.title}
        </div>
      );
  }
}

/** Keeps the newest line in view, unless the reader has scrolled up to read. */
function useStickToBottom() {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  // After every render: the content may have grown.
  useEffect(() => {
    const el = ref.current;
    if (el !== null && stuck.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = ref.current;
    if (el !== null) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  return { ref, onScroll };
}

export function ConversationView({
  conversation,
  loading,
}: {
  conversation: Conversation;
  loading: boolean;
}) {
  const { ref, onScroll } = useStickToBottom();
  const working = conversation.status !== "idle";
  const lastAgent = conversation.items.findLastIndex((item) => item.kind === "agent");
  return (
    <div
      data-slot="conversation"
      ref={ref}
      onScroll={onScroll}
      role="log"
      aria-label="Conversation"
      aria-busy={loading}
    >
      {loading ? <div data-slot="loading">Loading the conversation…</div> : null}
      {!loading && conversation.items.length === 0 ? (
        <div data-slot="empty">Nothing here yet. Say something below.</div>
      ) : null}
      {conversation.items.map((item, index) => (
        <ItemView
          key={`${item.kind}:${item.id}`}
          item={item}
          streaming={working && item.kind === "agent" && index === lastAgent}
        />
      ))}
      {conversation.lastStop?.stopReason === "error" ? (
        <div data-slot="notice" data-severity="error" role="alert">
          <ErrorCircleIcon size={14} />
          <span>
            The turn failed
            {conversation.lastStop.error?.message
              ? `: ${conversation.lastStop.error.message}`
              : "."}
          </span>
        </div>
      ) : null}
    </div>
  );
}
