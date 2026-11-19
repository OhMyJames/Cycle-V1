import { createCodePlugin } from "@streamdown/code";
import type { ComponentProps, ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import { type CodeThemeId, codeTheme, themesOf } from "../code-theme.ts";

/**
 * Markdown from an agent. It is untrusted: it can hold raw HTML, links and images the agent chose.
 * - Raw HTML is dropped (`skipHtml`), not rendered.
 * - Only http, https and mailto links are links; the rest is text. Opening one is main's business.
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
  if (!isSafeLink(href)) return <span data-slot="unsafe-link">{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function BlockedImage({ alt }: { alt?: string | undefined }) {
  return (
    <span data-slot="blocked-image">
      {alt ? `[image not loaded: ${alt}]` : "[image not loaded]"}
    </span>
  );
}

const components: ComponentProps<typeof Streamdown>["components"] = {
  a: SafeLink as never,
  img: BlockedImage as never,
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
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      skipHtml
      components={components}
      plugins={{ code: pluginFor(theme) }}
      controls={CONTROLS}
      lineNumbers={false}
      shikiTheme={[...themesOf(theme)] as never}
    >
      {text}
    </Streamdown>
  );
}
