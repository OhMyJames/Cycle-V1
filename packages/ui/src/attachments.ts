// Images and files in a prompt and in a conversation. Pure TypeScript: no React, no DOM, so the rules can be tested.
// What an agent sends is untrusted: an image is shown only if it is one of a few types, is base64, and is of a size the
// page can hold; anything else is a line of text saying what it was. A file is only ever named, never shown.

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

/**
 * What an attached file is sent as (.agents/notes/2026-11-22-attach-any-file.md): an image (ACP `image`), or, when the
 * agent takes embedded context, a text file (a `resource` with `text`) or a PDF (a `resource` with a base64 `blob`).
 * Anything else is refused before it is sent. These are also the words analytics counts with, never a name.
 */
export type AttachmentKind = "image" | "text" | "pdf";

/** What the agent of the session takes: images (`promptCapabilities.image`), files (`embeddedContext`). */
export type Accepts = { readonly images: boolean; readonly files: boolean };

export type Attachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** The MIME type it is sent with. */
  type: string;
  /** Base64 for an image or a PDF, as ACP carries it; the text itself for a text file. */
  data: string;
  /** Decoded bytes (a text file's are its UTF-8 bytes), as the daemon counts them. */
  bytes: number;
};

/**
 * What a file would be, by its type and name, before it is read: an image of a type every model takes, a PDF, or else
 * a file whose bytes decide (text if they are UTF-8; otherwise it is refused).
 */
export const kindOf = (file: { type: string; name: string }): AttachmentKind =>
  isImageType(file.type)
    ? "image"
    : file.type === "application/pdf" || /\.pdf$/i.test(file.name)
      ? "pdf"
      : "text";

/**
 * Whether a file's first bytes are a PDF's (`%PDF-`). A file named `.pdf` that is not one (an export saved under the wrong
 * name, an empty file) would be refused by the model and fail the whole turn, so it is refused in the box instead.
 */
export const isPdfBytes = (head: Uint8Array): boolean =>
  head.length >= 5 &&
  head[0] === 0x25 &&
  head[1] === 0x50 &&
  head[2] === 0x44 &&
  head[3] === 0x46 &&
  head[4] === 0x2d;

/**
 * A file's bytes as text, or undefined when they are not text: not UTF-8, or holding a NUL (a binary file that happens
 * to decode). A byte order mark is dropped.
 */
export const textOfBytes = (bytes: Uint8Array): string | undefined => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
};

const TEXT_APPLICATION =
  /^application\/(json|xml|javascript|ecmascript|x-sh|x-shellscript|x-yaml|yaml|toml|sql|.+\+json|.+\+xml)$/;

/** The MIME type a text file is sent with: its own when it says text, else `text/plain` (a `.ts` is often `video/mp2t`). */
export const textType = (type: string): string =>
  type.startsWith("text/") || TEXT_APPLICATION.test(type) ? type : "text/plain";

/**
 * The address an attached file is sent under. Not a path: the agent may be on another machine, and the page does not
 * know where the file was. The scheme says it is in the message, not on a disk; its last segment is the file's name.
 */
export const attachmentUri = (name: string): string => `attachment:///${encodeURIComponent(name)}`;

/** The name of an embedded file (ACP `resource`): the last segment of its uri, decoded. Undefined when it has none. */
export const resourceName = (block: { [key: string]: unknown }): string | undefined => {
  const resource = block.resource as { uri?: unknown } | undefined;
  if (typeof resource?.uri !== "string") return undefined;
  const last = resource.uri.split("/").filter(Boolean).at(-1);
  if (last === undefined) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

export type AttachmentProblem =
  | { reason: "type"; name: string }
  | { reason: "block-too-large"; name: string }
  | { reason: "prompt-too-large" }
  | { reason: "too-many" };

/**
 * Whether one more file may join those already chosen, by what the agent takes and the same limits the daemon holds
 * the prompt to. A file that may be text is let through here and refused once read if it is not.
 */
export const canAdd = (
  have: readonly Pick<Attachment, "bytes">[],
  next: { name: string; type: string; bytes: number },
  accepts: Accepts = { images: true, files: false },
): AttachmentProblem | undefined => {
  const kind = kindOf(next);
  if (kind === "image" ? !accepts.images : !accepts.files)
    return { reason: "type", name: next.name };
  if (next.bytes > ATTACHMENT_LIMITS.blockBytes)
    return { reason: "block-too-large", name: next.name };
  if (have.length + 1 > ATTACHMENT_LIMITS.blocks - 1) return { reason: "too-many" };
  const total = have.reduce((sum, a) => sum + a.bytes, 0) + next.bytes;
  if (total > ATTACHMENT_LIMITS.promptBytes) return { reason: "prompt-too-large" };
  return undefined;
};
