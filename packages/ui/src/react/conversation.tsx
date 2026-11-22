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
  type Resend,
  resendOf,
  textOf,
  windowStart,
} from "../model/index.ts";
import { blockHolds, reveal } from "../reveal.ts";
import { thinking } from "../thinking.ts";
import { useI18n } from "./i18n.tsx";
import { ThoughtIcon } from "./icons.tsx";
import { ImageBlockView } from "./image.tsx";
import { Markdown } from "./markdown.tsx";
import { PlanBlock } from "./plan.tsx";
import { StateBlock } from "./state-block.tsx";
import { ToolCard } from "./tool.tsx";
import { EndBlock, Notice, StepLine, WorkBlock } from "./turn.tsx";

export { toolSummary } from "./tool.tsx";

/** A file or folder the person named with @: the text already says "@path", so the link is not drawn a second time. */
const isMention = (block: Block, text: string): boolean => {
  if (block.type !== "resource_link") return false;
  const path = (block._meta as Record<string, unknown> | undefined)?.[MENTION_META];
  // Only when the words still name it: a link the text no longer shows is drawn, so a file sent is never invisible.
  return typeof path === "string" && text.includes(`@${path}`);
};

const linkName = (block: Block): string =>
  typeof block.name === "string" && block.name !== ""
    ? block.name
    : typeof block.uri === "string"
      ? block.uri
      : block.type;

function Blocks({ blocks, from }: { blocks: Block[]; from: "agent" | "user" }) {
  const words = blocks.map((b) => (b.type === "text" ? String(b.text) : "")).join("");
  return (
    <>
      {blocks
        .map((block, index) => ({ block, key: `${block.type}-${index}` }))
        .map(({ block, key }) =>
          block.type === "text" ? (
            <span key={key}>{String(block.text)}</span>
          ) : block.type === "image" ? (
            <ImageBlockView key={key} block={block} from={from} />
          ) : isMention(block, words) ? null : block.type === "resource_link" ? (
            // A link that is not a mention in the text: its name, marked off, so it reads as what was attached.
            <span data-slot="block-note" key={key}>
              [{linkName(block)}]
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
  resend,
}: {
  block: LaidBlock;
  /** This is the agent message that is still arriving. */
  streaming: boolean;
  /** This block is in the turn that is going. */
  live: boolean;
  /** The end of a turn that failed, whose message can be sent again. */
  resend?: Resend | undefined;
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
      return <EndBlock stop={block.stop} resend={resend} />;
    case "plan":
      return <PlanBlock item={block.item} />;
    case "compaction":
      return (
        <Notice
          severity={block.item.status === "failed" ? "error" : "info"}
          title={t(`compaction.${block.item.status}`)}
        />
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
/** Growth this soon after the reader pressed a control in the conversation is theirs, not something arriving. */
const ACTED_MS = 600;

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
  // The last turn, when it failed: its end offers to send its message again.
  const resend = useMemo(() => resendOf(conversation), [conversation]);

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

  // Asked to show an item (from the Overview): the window moves to its block if it is above it, and once it is drawn
  // (its card opened) it is scrolled to the middle and marked for a moment.
  const revealing = useRef<string | undefined>(undefined);
  useEffect(
    () =>
      reveal.subscribe(() => {
        const asked = reveal.get();
        if (asked === undefined || asked.sessionKey !== sessionKey) return;
        const at = blocks.findIndex((block) => blockHolds(block as never, asked.itemId));
        if (at === -1) return;
        if (at < start) anchor.current = blocks[at]?.key;
        stuck.current = false;
        revealing.current = asked.itemId;
        redraw();
      }),
    [sessionKey, blocks, start],
  );
  useEffect(() => {
    const id = revealing.current;
    const el = ref.current;
    if (id === undefined || el === null) return;
    revealing.current = undefined;
    let frames = 0;
    // Not undone by the next render: a streamed chunk must not stop the search, nor leave the mark on.
    const find = () => {
      if (!el.isConnected) return;
      const node = el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
      // The card that holds it opens on the next frame or two.
      if (node === null) {
        if (++frames < 10) requestAnimationFrame(find);
        return;
      }
      node.scrollIntoView?.({ block: "center" });
      node.setAttribute("data-revealed", "");
      setTimeout(() => node.removeAttribute("data-revealed"), 1200);
    };
    find();
  });

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

  // After every content growth while following the end: keep the end in view.
  useEffect(() => {
    const el = ref.current;
    if (el === null || loading || !stuck.current) return;
    if (blocks.length === 0 && conversation.status === "idle" && follow === 0) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks, conversation.status, follow, loading]);

  // What is drawn can grow after it is laid out: code is coloured when its highlighter loads, a code block off screen is
  // measured when it comes near. While following the end, the end is kept in view through that too; when reading above
  // it, nothing is moved. Growth the reader caused (showing a code block whole, opening a tool) is theirs to read: the view
  // stays, and it follows the end again only once they are back at it. One observer for the view's life; blocks added or
  // removed are watched or let go as they come.
  const acted = useRef(0);
  const following = useRef({ loading });
  following.current.loading = loading;
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const keep = new ResizeObserver(() => {
      if (!stuck.current || following.current.loading) return;
      if (performance.now() - acted.current < ACTED_MS) {
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX;
        return;
      }
      el.scrollTop = el.scrollHeight;
    });
    for (const child of Array.from(el.children)) keep.observe(child);
    const children = new MutationObserver((changes) => {
      for (const change of changes) {
        for (const node of Array.from(change.addedNodes))
          if (node instanceof Element) keep.observe(node);
        for (const node of Array.from(change.removedNodes))
          if (node instanceof Element) keep.unobserve(node);
      }
    });
    children.observe(el, { childList: true });
    // Only a control: a click that selects words, while a reply streams, is no reason to stop following it.
    const act = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("button, summary, [role='button']")
      )
        acted.current = performance.now();
    };
    el.addEventListener("pointerdown", act, true);
    el.addEventListener("keydown", act, true);
    return () => {
      keep.disconnect();
      children.disconnect();
      el.removeEventListener("pointerdown", act, true);
      el.removeEventListener("keydown", act, true);
    };
  }, []);

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
      {loading ? (
        <div data-slot="loading">
          <StateBlock tone="loading" title={t("conversation.loading")} />
        </div>
      ) : null}
      {!loading && conversation.items.length === 0 ? (
        <div data-slot="conversation-empty">
          <StateBlock tone="empty" title={t("conversation.empty")} />
        </div>
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
            resend={block.kind === "end" && resend?.turn === block.turn ? resend : undefined}
          />
        </div>
      ))}
      {!loading ? (
        <StepLine conversation={conversation} awaitingApproval={awaitingApproval} />
      ) : null}
    </div>
  );
}
