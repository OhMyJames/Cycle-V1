import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  type Block,
  type BlockCache,
  blocksOf,
  type Conversation,
  type LaidBlock,
  textOf,
} from "../model/index.ts";
import { thinking } from "../thinking.ts";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ThoughtIcon } from "./icons.tsx";
import { ImageBlockView } from "./image.tsx";
import { Markdown } from "./markdown.tsx";
import { ToolCard } from "./tool.tsx";
import { EndBlock, Notice, StepLine, WorkBlock } from "./turn.tsx";

export { toolSummary } from "./tool.tsx";

function Blocks({ blocks, from }: { blocks: Block[]; from: "agent" | "user" }) {
  return (
    <>
      {blocks
        .map((block, index) => ({ block, key: `${block.type}-${index}` }))
        .map(({ block, key }) =>
          block.type === "text" ? (
            <span key={key}>{String(block.text)}</span>
          ) : block.type === "image" ? (
            <ImageBlockView key={key} block={block} from={from} />
          ) : (
            <span data-slot="block-note" key={key}>
              [{block.type}]
            </span>
          ),
        )}
    </>
  );
}

/** An agent's message: its text as markdown, and its images where they came, in order. */
function AgentBlocks({ blocks, streaming }: { blocks: Block[]; streaming: boolean }) {
  const parts: { key: string; text?: string; image?: Block }[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "image") parts.push({ key: `image-${index}`, image: block });
    else {
      const last = parts.at(-1);
      if (last?.text !== undefined) last.text += textOf([block]);
      else parts.push({ key: `text-${index}`, text: textOf([block]) });
    }
  }
  return (
    <>
      {parts.map((part, at) =>
        part.image !== undefined ? (
          <ImageBlockView key={part.key} block={part.image} from="agent" />
        ) : (
          <Markdown
            key={part.key}
            text={part.text ?? ""}
            streaming={streaming && at === parts.length - 1}
          />
        ),
      )}
    </>
  );
}

const BlockView = memo(function BlockView({
  block,
  streaming,
  live,
}: {
  block: LaidBlock;
  /** This is the agent message that is still arriving. */
  streaming: boolean;
  /** This block is in the turn that is going. */
  live: boolean;
}) {
  const { t } = useI18n();
  switch (block.kind) {
    case "user":
      return (
        <div data-slot="message" data-role="user">
          <Blocks blocks={block.item.blocks} from="user" />
        </div>
      );
    case "agent":
      return (
        <div data-slot="message" data-role="agent">
          <AgentBlocks blocks={block.item.blocks} streaming={streaming} />
        </div>
      );
    case "thought":
      return (
        <Collapsible data-kind="thought">
          <CollapsibleTrigger>
            <ThoughtIcon size={14} />
            {t("thought.label")}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div data-slot="thought-text">{textOf(block.item.blocks)}</div>
          </CollapsiblePanel>
        </Collapsible>
      );
    case "work":
      return <WorkBlock tools={block.tools} live={live} />;
    case "failed":
      return <ToolCard tool={block.tool} />;
    case "end":
      return <EndBlock stop={block.stop} />;
    case "plan":
      return (
        <ol data-slot="plan" aria-label={t("plan.label")}>
          {block.item.entries
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
      return <Notice severity={block.item.severity} title={block.item.title} />;
  }
});

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
  const { t } = useI18n();
  const { ref, onScroll } = useStickToBottom();
  const showThinking = useSyncExternalStore(thinking.subscribe, thinking.get, thinking.get);
  // Turns that have not changed give back the same blocks, so only the turn that is going is drawn again.
  const cache = useRef<BlockCache>(new Map());
  const blocks = useMemo(
    () => blocksOf(conversation, { showThinking }, cache.current),
    [conversation, showThinking],
  );
  const working = conversation.status !== "idle";
  const lastAgent = blocks.findLastIndex((block) => block.kind === "agent");
  return (
    <div
      data-slot="conversation"
      ref={ref}
      onScroll={onScroll}
      role="log"
      aria-label={t("conversation.label")}
      aria-busy={loading}
    >
      {loading ? <div data-slot="loading">{t("conversation.loading")}</div> : null}
      {!loading && conversation.items.length === 0 ? (
        <div data-slot="empty">{t("conversation.empty")}</div>
      ) : null}
      {blocks.map((block, index) => (
        <div key={block.key} data-slot="block" data-turn-start={block.startsTurn || undefined}>
          <BlockView
            block={block}
            streaming={working && index === lastAgent}
            live={working && block.turn === conversation.turns}
          />
        </div>
      ))}
      {!loading ? <StepLine conversation={conversation} /> : null}
    </div>
  );
}
