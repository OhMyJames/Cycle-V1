import type { ComponentProps, ReactNode } from "react";
import { Streamdown } from "streamdown";

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

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      skipHtml
      components={components}
    >
      {text}
    </Streamdown>
  );
}
