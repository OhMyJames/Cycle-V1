// A ```mermaid fence from an agent, drawn as a picture. The source is untrusted (docs/desktop.md), so:
// - Mermaid runs with securityLevel "strict" (labels are sanitized, click handlers and links in a diagram are off) and
//   with no HTML labels; a diagram's own `%%{init}%%` or front matter cannot turn either back on (`secure` below).
// - What Mermaid draws never becomes part of the page. It is shown as an <img> of a data URL, and an SVG drawn as an image
//   runs no script and loads nothing, whatever is in it. The page's CSP (no connections, images only from itself and
//   data:) holds while Mermaid lays the diagram out.
// - Mermaid itself is loaded the first time a diagram is drawn, not at startup.
// The colours are the page's tokens, read when the diagram is drawn: a diagram is drawn once per light and dark.
// Why this and not Streamdown's mermaid plugin: .agents/notes/2026-11-22-mermaid-diagrams-as-images.md.

export type DiagramScheme = "light" | "dark";

export type Drawn =
  | { ok: true; src: string; width: number; height: number; title: string }
  | { ok: false };

/**
 * A font every machine has: the picture cannot use the page's own fonts, and Mermaid measures the labels in the page
 * with the font it is told, so both must be one the system has.
 */
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

/** What a diagram's own configuration may not change. Mermaid's own list is kept; the rest is ours. */
const SECURE = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "htmlLabels",
  "flowchart",
  "theme",
  "themeVariables",
  "themeCSS",
  "fontFamily",
  "darkMode",
];

/** The largest source drawn; a longer one stays a code block. Mermaid's own limit is 50 000. */
export const MAX_SOURCE = 20_000;

/** A token as a colour Mermaid can read (`rgb(…)`), as the page has it now. */
const colourOf = (probe: HTMLElement, token: string): string => {
  probe.style.color = `var(${token})`;
  return getComputedStyle(probe).color;
};

const themeOf = (scheme: DiagramScheme): Record<string, string | boolean> => {
  const probe = document.createElement("span");
  probe.hidden = true;
  document.body.append(probe);
  try {
    const c = (token: string) => colourOf(probe, token);
    const ink = c("--cycle-ink");
    const raised = c("--cycle-surface-raised");
    const node = c("--cycle-surface-message");
    const edge = c("--cycle-input-border");
    const line = c("--cycle-ink-muted");
    return {
      darkMode: scheme === "dark",
      fontFamily: FONT,
      fontSize: "14px",
      background: raised,
      primaryColor: node,
      primaryTextColor: ink,
      primaryBorderColor: edge,
      secondaryColor: c("--cycle-surface-hover"),
      secondaryTextColor: ink,
      secondaryBorderColor: edge,
      tertiaryColor: c("--cycle-surface-sidebar"),
      tertiaryTextColor: ink,
      tertiaryBorderColor: c("--cycle-border-default"),
      mainBkg: node,
      nodeBorder: edge,
      nodeTextColor: ink,
      textColor: ink,
      titleColor: ink,
      lineColor: line,
      clusterBkg: c("--cycle-surface-sidebar"),
      clusterBorder: c("--cycle-border-default"),
      edgeLabelBackground: raised,
      noteBkgColor: c("--cycle-surface-hover"),
      noteTextColor: ink,
      noteBorderColor: edge,
      actorBkg: node,
      actorBorder: edge,
      actorTextColor: ink,
      actorLineColor: line,
      signalColor: ink,
      signalTextColor: ink,
      labelTextColor: ink,
    };
  } finally {
    probe.remove();
  }
};

type Mermaid = typeof import("mermaid")["default"];
let loading: Promise<Mermaid> | undefined;
const loadMermaid = (): Promise<Mermaid> => {
  loading ??= import("mermaid").then((module) => module.default);
  return loading;
};

/** The picture's size and name, and the SVG as a data URL; or nothing, if it is not an SVG. */
const pictureOf = (svg: string): Drawn => {
  // Mermaid writes HTML's serialization (a label's line break is `<br>`), so it is read as HTML, in a document that is
  // never shown and runs nothing, and written back as XML, which a picture needs.
  const root = new DOMParser().parseFromString(svg, "text/html").body.firstElementChild;
  if (root === null || root.tagName.toLowerCase() !== "svg") return { ok: false };
  const box = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const width = Math.ceil(box[2] ?? 0);
  const height = Math.ceil(box[3] ?? 0);
  if (!(width > 0 && height > 0)) return { ok: false };
  // Mermaid sizes the drawing to its container (width 100%, a max-width); as a picture it has its own size.
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.removeAttribute("style");
  // Strict mode keeps a `click X "https://…"` as a link. A picture's links do nothing; they are not kept as if they did.
  for (const link of Array.from(root.querySelectorAll("a"))) link.replaceWith(...link.childNodes);
  const title = root.querySelector(":scope > title")?.textContent?.trim() ?? "";
  const text = new XMLSerializer().serializeToString(root);
  return {
    ok: true,
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`,
    width,
    height,
    title,
  };
};

// Mermaid keeps one configuration and lays out in the page: one diagram at a time.
let queue: Promise<unknown> = Promise.resolve();
let count = 0;
const draw = async (source: string, scheme: DiagramScheme): Promise<Drawn> => {
  if (source.trim() === "" || source.length > MAX_SOURCE) return { ok: false };
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: "base",
    themeVariables: themeOf(scheme),
    fontFamily: FONT,
    // A sequence diagram's own sizes are larger than the rest's.
    sequence: { actorFontSize: 14, messageFontSize: 14, noteFontSize: 14 },
    secure: SECURE,
    // A diagram that does not parse is left to us (the source is shown), not drawn as Mermaid's error picture.
    suppressErrorRendering: true,
    deterministicIds: true,
  });
  try {
    count += 1;
    const { svg } = await mermaid.render(`cycle-diagram-${count}`, source);
    return pictureOf(svg);
  } catch {
    return { ok: false };
  }
};

/**
 * What is drawn of a source, in a scheme. Kept, failures too: a conversation draws its diagrams again each time it is
 * opened, and a source that did not parse is not tried again. The last few are kept.
 */
const drawn = new Map<string, Promise<Drawn>>();
const KEPT = 64;

export const drawDiagram = (source: string, scheme: DiagramScheme): Promise<Drawn> => {
  const key = `${scheme}\n${source}`;
  const kept = drawn.get(key);
  if (kept !== undefined) return kept;
  // Whatever goes wrong (Mermaid's code could not be loaded, a token could not be read) is a diagram not drawn.
  const attempt = () => draw(source, scheme).catch((): Drawn => ({ ok: false }));
  const result = queue.then(attempt, attempt);
  queue = result;
  if (drawn.size >= KEPT) drawn.delete(drawn.keys().next().value ?? "");
  drawn.set(key, result);
  return result;
};
