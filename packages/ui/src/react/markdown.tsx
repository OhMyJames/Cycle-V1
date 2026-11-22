import { createCodePlugin } from "@streamdown/code";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { defaultRehypePlugins, Streamdown, useIsCodeFenceIncomplete } from "streamdown";
import { type CodeThemeId, codeTheme, themesOf } from "../code-theme.ts";
import { mendStreaming } from "../markdown-mend.ts";
import { AgentLink } from "./agent-link.tsx";
import { useI18n } from "./i18n.tsx";
import { useOptionalAppStore } from "./store-context.tsx";

/**
 * Markdown from an agent. It is untrusted: it can hold raw HTML, links and images the agent chose.
 * - Raw HTML is dropped (`skipHtml`), not rendered.
 * - Only http, https and mailto links are links; the rest is text. A click asks before it opens (`AgentLink`).
 * - An image is never fetched, so reading a message cannot make a request. It shows as text.
 * Streamdown's own defaults allow every image and link prefix, so none of this is left to them.
 */

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export const isSafeLink = (href: string | undefined): boolean => {
  if (href === undefined) return false;
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
};

function SafeLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const store = useOptionalAppStore();
  if (href === undefined || !isSafeLink(href))
    return <span data-slot="unsafe-link">{children}</span>;
  // That a link in a message was opened, never which.
  return (
    <AgentLink href={href} onOpened={() => store?.track("message_link_opened", {})}>
      {children}
    </AgentLink>
  );
}

function BlockedImage({ alt }: { alt?: string | undefined }) {
  return (
    <span data-slot="blocked-image">
      {alt ? `[image not loaded: ${alt}]` : "[image not loaded]"}
    </span>
  );
}

/**
 * A code block longer than this many lines is shown in part when it is first drawn whole. How many lines show (12) is the
 * stylesheet's (`[data-slot="code-fold"][data-folded]`), in lines of the block's own height.
 */
export const FOLD_OVER = 30;

/** The reply this block is in is still being written. */
const Streaming = createContext(false);

const lineCount = (code: ReactElement): number => {
  const text = (code.props as { children?: unknown }).children;
  const source = typeof text === "string" ? text : Array.isArray(text) ? text.join("") : "";
  return source.replace(/\n$/, "").split("\n").length;
};

/**
 * A code block, and when it is long, a way to show all of it or part. A block that arrived whole (an answer read again, a
 * session opened) starts in part; one that was written on screen stays whole, so the end of a reply never shrinks under
 * the reader. Copy copies all of it either way. Folding is the block's own: Streamdown's height cap, which scrolled the
 * block inside the conversation's scroll, is off.
 */
function CodeFold({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  const store = useOptionalAppStore();
  const incomplete = useIsCodeFenceIncomplete();
  const streaming = useContext(Streaming);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const code = isValidElement(children) ? children : null;
  const lines = code === null ? 0 : lineCount(code);
  // Not while the reply is written, even when the block came whole in one batch or was drawn again (a session reopened).
  const [folded, setFolded] = useState(() => !streaming && !incomplete && lines > FOLD_OVER);
  const block = code === null ? children : cloneElement(code, { "data-block": "true" } as never);
  const foldable = !incomplete && lines > FOLD_OVER;
  const toggle = () => {
    if (folded) store?.track("code_block_expanded", {});
    setFolded(!folded);
    // Shown in part again, the block is shorter: the button stays where the reader is.
    if (!folded) requestAnimationFrame(() => button.current?.scrollIntoView({ block: "nearest" }));
  };
  // The same element around the block whether it can fold or not, so a fence that closes while it streams keeps its block.
  return (
    <div data-slot="code-fold" data-folded={(foldable && folded) || undefined} id={id}>
      {block}
      {foldable ? (
        <button
          ref={button}
          type="button"
          data-slot="code-fold-toggle"
          aria-expanded={!folded}
          aria-controls={id}
          onClick={toggle}
        >
          {folded ? t("code.showAll", { count: lines }) : t("code.showFewer")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Streamdown's own HTML steps, in their order, with one change: a link it will not make (a relative path, which is what an
 * agent writes for a file) is its words, not its words and " [blocked]". It is still never a link; opening a file from a
 * message is the Files panel's (CYCL-92).
 */
const rehypePlugins = Object.entries(defaultRehypePlugins).map(([name, plugin]) => {
  if (name !== "harden" || !Array.isArray(plugin)) return plugin;
  const [harden, options] = plugin as [unknown, Record<string, unknown>];
  return [harden, { ...options, linkBlockPolicy: "text-only" }];
}) as ComponentProps<typeof Streamdown>["rehypePlugins"];

const components: ComponentProps<typeof Streamdown>["components"] = {
  a: SafeLink as never,
  img: BlockedImage as never,
  pre: CodeFold as never,
};

/**
 * Code is coloured by Shiki through Streamdown's code plugin (Streamdown has no highlighting of its own: without the
 * plugin a code block is plain text). Which themes is the person's choice (`code-theme.ts`). The plugin uses Shiki's
 * JavaScript regex engine, so it needs no WebAssembly and the page's CSP stays as it is.
 */
const plugins = new Map<CodeThemeId, ReturnType<typeof createCodePlugin>>();
const pluginFor = (id: CodeThemeId) => {
  let plugin = plugins.get(id);
  if (plugin === undefined) {
    plugin = createCodePlugin({ themes: [...themesOf(id)] as never });
    plugins.set(id, plugin);
  }
  return plugin;
};

/**
 * Code keeps one control, Copy, shown when the block is hovered or focused. Tables keep none: the full-screen view and the
 * CSV download were a toolbar over every table, louder than the table. Diagrams are not drawn (no mermaid plugin).
 */
const CONTROLS = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
  image: false,
};

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const theme = useSyncExternalStore(codeTheme.subscribe, codeTheme.get, codeTheme.get);
  return (
    <Streaming.Provider value={streaming}>
      <Streamdown
        mode="streaming"
        isAnimating={streaming}
        parseIncompleteMarkdown={streaming}
        codeBlockMaxHeight="none"
        tableMaxHeight="none"
        skipHtml
        rehypePlugins={rehypePlugins}
        components={components}
        plugins={{ code: pluginFor(theme) }}
        controls={CONTROLS}
        lineNumbers={false}
        shikiTheme={[...themesOf(theme)] as never}
      >
        {streaming ? mendStreaming(text) : text}
      </Streamdown>
    </Streaming.Provider>
  );
}
