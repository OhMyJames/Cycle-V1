import { type ContentBlock, RequestError } from "@cycle/acp";

/** What the Claude SDK takes as the content of a user message. */
export type SdkContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
      title?: string;
    };

/** A value in a quoted attribute: it cannot end the quote or the tag. */
const attribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** A file's text cannot close the tag it is in: a `</file` inside it is written `<\/file`. */
const closing = (text: string): string => text.replace(/<\/file/gi, "<\\/file");

const refuse = (what: string, data: Record<string, unknown>): never => {
  throw new RequestError(-32602, what, data);
};

/**
 * A prompt as the SDK takes it. A prompt of only text and links stays a string. Every block is
 * either carried or the prompt is refused: nothing is dropped (decision 0010). The daemon has
 * checked the sizes; this only knows what it can hand to Claude.
 *
 * A `resource_link` is a mention, not content: the agent may read what it names if the path is on
 * its machine. A text resource is put in as a tagged block that names its uri.
 */
export const toSdkContent = (blocks: readonly ContentBlock[]): string | SdkContent[] => {
  const parts: SdkContent[] = [];
  let plain = true;
  for (const [index, block] of blocks.entries()) {
    const b = block as Record<string, unknown> & { type: string };
    if (b.type === "text") {
      parts.push({ type: "text", text: String(b.text) });
    } else if (b.type === "resource_link") {
      parts.push({ type: "text", text: `[${String(b.name)}](${String(b.uri)})` });
    } else if (b.type === "image") {
      plain = false;
      parts.push({
        type: "image",
        source: { type: "base64", media_type: String(b.mimeType), data: String(b.data) },
      });
    } else if (b.type === "resource") {
      const resource = b.resource as Record<string, unknown>;
      if (typeof resource.text === "string") {
        plain = false;
        parts.push({
          type: "text",
          text: `<file uri="${attribute(String(resource.uri))}">\n${closing(resource.text)}\n</file>`,
        });
      } else if (typeof resource.blob === "string" && resource.mimeType === "application/pdf") {
        plain = false;
        parts.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: resource.blob },
          title: String(resource.uri),
        });
      } else {
        refuse("Unsupported embedded resource", { index, mimeType: resource.mimeType });
      }
    } else {
      refuse("Unsupported content block", { index, type: b.type });
    }
  }
  if (parts.length === 0) refuse("A prompt needs content", {});
  if (plain) return parts.map((part) => (part as { text: string }).text).join("\n\n");
  return parts;
};
