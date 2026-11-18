// Images in a prompt and in a conversation. Pure TypeScript: no React, no DOM, so the rules can be tested.
// What an agent sends is untrusted: an image is shown only if it is one of a few types, is base64, and is of a size the
// page can hold; anything else is a line of text saying what it was.

/** The types every Claude-class model takes (docs/decisions/0010). SVG is not one: it is code, not a picture. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/**
 * What a prompt may carry. This mirrors `PROMPT_LIMITS` of `@cycle/protocol` (decision 0010), which the daemon enforces:
 * the copy is here only to tell the person at once, before anything is sent. Decoded bytes.
 */
export const ATTACHMENT_LIMITS = {
  blockBytes: 5 * 1024 * 1024,
  promptBytes: 12 * 1024 * 1024,
  blocks: 32,
} as const;

/** The most of an image's base64 text the page will draw (about 15 MB of picture). */
export const MAX_SHOWN_BASE64 = 20 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const isImageType = (type: unknown): type is ImageType =>
  typeof type === "string" && (IMAGE_TYPES as readonly string[]).includes(type);

/** Bytes a base64 text decodes to, or undefined if it is not base64. */
export const base64Bytes = (data: string): number | undefined => {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
};

export type ImageView =
  | { ok: true; src: string; type: ImageType; bytes: number; name: string }
  | { ok: false; reason: "unsupported" | "too-large"; type: string; bytes?: number };

/** What to draw for an image block of ACP (`{ type: "image", data, mimeType, uri? }`). */
export const viewOfImage = (block: { [key: string]: unknown }): ImageView => {
  const type = typeof block.mimeType === "string" ? block.mimeType : "unknown";
  const data = typeof block.data === "string" ? block.data : "";
  if (!isImageType(type)) return { ok: false, reason: "unsupported", type };
  if (data.length > MAX_SHOWN_BASE64) return { ok: false, reason: "too-large", type };
  const bytes = base64Bytes(data);
  if (bytes === undefined || bytes === 0) return { ok: false, reason: "unsupported", type };
  const uri = typeof block.uri === "string" ? block.uri : "";
  // The file's name when the sender gave one; otherwise none (the interface says what it is, in its own words).
  const name = uri.split("/").filter(Boolean).at(-1) ?? "";
  return { ok: true, src: `data:${type};base64,${data}`, type, bytes, name };
};

export type Attachment = {
  id: string;
  name: string;
  type: ImageType;
  /** Base64, as ACP carries it. */
  data: string;
  bytes: number;
};

export type AttachmentProblem =
  | { reason: "type"; name: string }
  | { reason: "block-too-large"; name: string }
  | { reason: "prompt-too-large" }
  | { reason: "too-many" };

/** Whether one more image may join those already chosen, by the same limits the daemon holds the prompt to. */
export const canAdd = (
  have: readonly Pick<Attachment, "bytes">[],
  next: { name: string; type: string; bytes: number },
): AttachmentProblem | undefined => {
  if (!isImageType(next.type)) return { reason: "type", name: next.name };
  if (next.bytes > ATTACHMENT_LIMITS.blockBytes)
    return { reason: "block-too-large", name: next.name };
  if (have.length + 1 > ATTACHMENT_LIMITS.blocks - 1) return { reason: "too-many" };
  const total = have.reduce((sum, a) => sum + a.bytes, 0) + next.bytes;
  if (total > ATTACHMENT_LIMITS.promptBytes) return { reason: "prompt-too-large" };
  return undefined;
};
