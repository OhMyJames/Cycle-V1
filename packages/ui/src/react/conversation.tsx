import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useEffect, useRef } from "react";
import type { Block, Conversation, Item, ToolItem } from "../model/index.ts";
import { textOf } from "../model/index.ts";
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

function ToolCard({ tool }: { tool: ToolItem }) {
  const status = tool.status ?? "pending";
  const output =
    tool.content.length > 0
      ? textOf(tool.content.flatMap((c) => (c.type === "content" ? [c.content as Block] : [c])))
      : stringify(tool.rawOutput);
  const summary = toolSummary(tool);
  return (
    <Collapsible data-slot="tool" data-status={status} data-variant="card">
      <CollapsibleTrigger>
        <span data-slot="tool-name">{tool.name ?? "Tool"}</span>
        <span data-slot="tool-summary">{summary}</span>
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
        <Collapsible data-slot="thought" data-variant="card">
          <CollapsibleTrigger>Thinking</CollapsibleTrigger>
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
                {entry.content}
              </li>
            ))}
        </ol>
      );
    case "notice":
      return (
        <div data-slot="notice" data-severity={item.severity} role="status">
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
          The turn failed
          {conversation.lastStop.error?.message ? `: ${conversation.lastStop.error.message}` : "."}
        </div>
      ) : null}
    </div>
  );
}
