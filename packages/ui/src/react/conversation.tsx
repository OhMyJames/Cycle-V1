import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import { MENTION_META } from "../draft.ts";
import {
  type Block,
  type BlockCache,
  blocksOf,
  type Conversation,
  earlierAnchor,
  type LaidBlock,
  PAGE,
  textOf,
  windowStart,
} from "../model/index.ts";
import { thinking } from "../thinking.ts";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ThoughtIcon } from "./icons.tsx";
import { ImageBlockView } from "./image.tsx";
import { Markdown } from "./markdown.tsx";
import { ToolCard } from "./tool.tsx";
import { EndBlock, Notice, StepLine, WorkBlock } from "./turn.tsx";

export { toolSummary } from "./tool.tsx";

/** A file or folder the person named with @: the text already says "@path", so the link is not drawn a second time. */
const isMention = (block: Block): boolean =>
  block.type === "resource_link" &&
  typeof (block._meta as Record<string, unknown> | undefined)?.[MENTION_META] === "string";

const linkName = (block: Block): string =>
  typeof block.name === "string" && block.name !== ""
    ? block.name
    : typeof block.uri === "string"
      ? block.uri
      : block.type;

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
          ) : isMention(block) ? null : block.type === "resource_link" ? (
            // A link that is not a mention in the text: its name, so it reads as what it points to.
            <span data-slot="block-note" key={key}>
              {linkName(block)}
            </span>
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

/**
 * Where the reader is in each session this page has shown, so going back finds them where they were: the first block that
 * was drawn (when they were not at the end) and the scroll offset, or "bottom". Kept in the page's memory, newest last,
 * and only the most recent few are kept.
 */
type Reading = { anchor: string | undefined; top: number | "bottom" };
const readings = new Map<string, Reading>();
const MAX_READINGS = 50;
const remember = (key: string, reading: Reading) => {
  readings.delete(key);
  readings.set(key, reading);
  const oldest = readings.keys().next();
  if (readings.size > MAX_READINGS && oldest.done !== true) readings.delete(oldest.value);
};

/** How near the top (in pixels) the first block shown may be before earlier ones are added. */
const LEAD_PX = 800;
/** Within this many pixels of the end, the reader counts as at the end and follows what arrives. */
const NEAR_END_PX = 48;

export function ConversationView({
  conversation,
  loading,
  awaitingApproval,
  sessionKey,
  follow,
}: {
  conversation: Conversation;
  loading: boolean;
  awaitingApproval: boolean;
  /** Names the session, to remember where it was being read. */
  sessionKey: string;
  /** Changes each time the person sends a message: it is shown, wherever they were reading. */
  follow: number;
}) {
  const { t } = useI18n();
  const showThinking = useSyncExternalStore(thinking.subscribe, thinking.get, thinking.get);
  // Turns that have not changed give back the same blocks, so only the turn that is going is drawn again.
  const cache = useRef<BlockCache>(new Map());
  const blocks = useMemo(
    () => blocksOf(conversation, { showThinking }, cache.current),
    [conversation, showThinking],
  );

  // A long conversation shows its end. While the reader is at the end the window is the last page, and slides as blocks
  // arrive; once they leave the end it is pinned to its first block (the anchor), so what arrives does not move the top.
  const saved = useRef(readings.get(sessionKey)).current;
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | undefined>(saved?.anchor);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const start = windowStart(blocks, anchor.current);
  // An anchor whose block is gone (thinking was hidden, a turn was laid again): back to the last page.
  if (anchor.current !== undefined && blocks[start]?.key !== anchor.current)
    anchor.current = undefined;
  const stuck = useRef(saved === undefined || saved.top === "bottom");
  const restored = useRef(false);
  const prepending = useRef<{ node: Element; top: number } | null>(null);
  const refocus = useRef(false);
  const seenFollow = useRef(follow);

  const showEarlier = () => {
    const el = ref.current;
    const node = el?.querySelector('[data-slot="block"]') ?? null;
    prepending.current =
      el !== null && node !== null ? { node, top: node.getBoundingClientRect().top } : null;
    // For the frame that adds blocks above the reader: the browser's own anchoring must not move the view as well, and a
    // screen reader must not be told of the whole page that was added.
    el?.setAttribute("data-prepending", "");
    el?.setAttribute("aria-live", "off");
    refocus.current = document.activeElement?.getAttribute("data-slot") === "earlier";
    anchor.current = earlierAnchor(blocks, start);
    redraw();
  };

  // Blocks added above the reader would push what they are reading down: the view is moved by how far that block moved.
  useLayoutEffect(() => {
    const el = ref.current;
    const before = prepending.current;
    if (el !== null && before !== null) {
      prepending.current = null;
      if (before.node.isConnected)
        el.scrollTop += before.node.getBoundingClientRect().top - before.top;
      requestAnimationFrame(() => {
        el.removeAttribute("data-prepending");
        el.removeAttribute("aria-live");
      });
    }
    // The button that was pressed is gone, there being nothing earlier: focus goes to the conversation, not to the page.
    if (el !== null && refocus.current) {
      refocus.current = false;
      if (el.querySelector('[data-slot="earlier"]') === null) el.focus();
    }
  });

  // Where the reader was comes back with the session, once it is loaded.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || loading || restored.current) return;
    restored.current = true;
    if (saved !== undefined && saved.top !== "bottom") {
      stuck.current = false;
      el.scrollTop = saved.top;
    }
  }, [loading, saved]);

  // What the person has just sent is shown, wherever they were reading.
  useEffect(() => {
    if (follow === seenFollow.current) return;
    seenFollow.current = follow;
    stuck.current = true;
    anchor.current = undefined;
  }, [follow]);

  // After every render: the content may have grown.
  useEffect(() => {
    const el = ref.current;
    if (el !== null && stuck.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = ref.current;
    if (el === null) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX;
    if (stuck.current) anchor.current = undefined;
    else if (anchor.current === undefined) anchor.current = blocks[start]?.key;
    remember(sessionKey, { anchor: anchor.current, top: stuck.current ? "bottom" : el.scrollTop });
    if (el.scrollTop < LEAD_PX && start > 0) showEarlier();
  };

  const working = conversation.status !== "idle";
  const lastAgent = blocks.findLastIndex((block) => block.kind === "agent");
  return (
    <div
      data-slot="conversation"
      ref={ref}
      onScroll={onScroll}
      role="log"
      tabIndex={-1}
      aria-label={t("conversation.label")}
      aria-busy={loading}
    >
      {loading ? <div data-slot="loading">{t("conversation.loading")}</div> : null}
      {!loading && conversation.items.length === 0 ? (
        <div data-slot="empty">{t("conversation.empty")}</div>
      ) : null}
      {start > 0 ? (
        <button type="button" data-slot="earlier" onClick={showEarlier}>
          {t("conversation.earlier")}
        </button>
      ) : null}
      {blocks.slice(start).map((block, at) => (
        <div key={block.key} data-slot="block" data-turn-start={block.startsTurn || undefined}>
          <BlockView
            block={block}
            streaming={working && start + at === lastAgent && block.turn === conversation.turns}
            live={working && block.turn === conversation.turns}
          />
        </div>
      ))}
      {!loading ? (
        <StepLine conversation={conversation} awaitingApproval={awaitingApproval} />
      ) : null}
    </div>
  );
}
