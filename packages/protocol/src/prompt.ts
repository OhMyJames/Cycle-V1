import { z } from "zod";

/** What a prompt may carry (docs/protocol.md §8, decision 0010). Decoded bytes, not base64. */
export const PROMPT_LIMITS = {
  blockBytes: 5 * 1024 * 1024,
  promptBytes: 12 * 1024 * 1024,
  blocks: 32,
} as const;

/** The image types every Claude-class model takes. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** What an agent takes in a prompt beyond text and links: ACP's `PromptCapabilities`. */
export const PromptCapabilitiesSchema = z.object({
  image: z.object({}).loose().nullish(),
  audio: z.object({}).loose().nullish(),
  embeddedContext: z.object({}).loose().nullish(),
});
export type PromptCapabilities = z.infer<typeof PromptCapabilitiesSchema>;

/** Why a prompt was refused. Short codes: a client may act on them, never parse the message. */
export type PromptProblemReason =
  | "empty"
  | "too_many_blocks"
  | "unsupported_block"
  | "unsupported_media_type"
  | "block_too_large"
  | "prompt_too_large"
  | "invalid_base64";

export type PromptProblem = { reason: PromptProblemReason; index?: number };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Bytes a base64 string decodes to, or undefined if it is not base64. */
export const base64Bytes = (data: string): number | undefined => {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
};

type Block = { type?: unknown; [key: string]: unknown };

/**
 * The first thing wrong with a prompt, or undefined if it is acceptable to an agent with
 * `capabilities`. Nothing is dropped: a prompt is taken whole or refused. The daemon enforces
 * this; a client can call it before sending.
 */
export const checkPrompt = (
  prompt: readonly unknown[],
  capabilities: PromptCapabilities | undefined,
): PromptProblem | undefined => {
  if (prompt.length === 0) return { reason: "empty" };
  if (prompt.length > PROMPT_LIMITS.blocks) return { reason: "too_many_blocks" };
  let total = 0;
  for (const [index, raw] of prompt.entries()) {
    const block = (typeof raw === "object" && raw !== null ? raw : {}) as Block;
    let bytes = 0;
    if (block.type === "text") {
      // Text counts too: a pasted file of text is as large on the wire as an image of the same size.
      bytes = typeof block.text === "string" ? new TextEncoder().encode(block.text).length : 0;
    } else if (block.type === "resource_link") {
      bytes = 0;
    } else if (block.type === "image") {
      if (capabilities?.image == null) return { reason: "unsupported_block", index };
      if (!(IMAGE_TYPES as readonly unknown[]).includes(block.mimeType)) {
        return { reason: "unsupported_media_type", index };
      }
      const decoded = typeof block.data === "string" ? base64Bytes(block.data) : undefined;
      if (decoded === undefined) return { reason: "invalid_base64", index };
      bytes = decoded;
    } else if (block.type === "resource") {
      if (capabilities?.embeddedContext == null) return { reason: "unsupported_block", index };
      const resource = (block.resource ?? {}) as Record<string, unknown>;
      if (typeof resource.text === "string") {
        bytes = new TextEncoder().encode(resource.text).length;
      } else if (typeof resource.blob === "string") {
        if (resource.mimeType !== "application/pdf") {
          return { reason: "unsupported_media_type", index };
        }
        const decoded = base64Bytes(resource.blob);
        if (decoded === undefined) return { reason: "invalid_base64", index };
        bytes = decoded;
      } else {
        return { reason: "unsupported_block", index };
      }
    } else {
      return { reason: "unsupported_block", index };
    }
    if (bytes > PROMPT_LIMITS.blockBytes) return { reason: "block_too_large", index };
    total += bytes;
    if (total > PROMPT_LIMITS.promptBytes) return { reason: "prompt_too_large", index };
  }
  return undefined;
};
