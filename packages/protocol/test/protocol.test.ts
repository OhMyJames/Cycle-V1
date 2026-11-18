import { expect, test } from "bun:test";
import {
  ACP_ERROR_CODES,
  agentsList,
  CycleErrorCode,
  checkPrompt,
  META,
  NOTIFICATIONS,
  PROMPT_LIMITS,
  seqOf,
} from "../src/index.ts";

test("Cycle's error codes do not collide with ACP's or each other", () => {
  const codes = Object.values(CycleErrorCode);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) expect(ACP_ERROR_CODES).not.toContain(code);
});

test("every Cycle method and notification is under _cycle/", () => {
  expect(agentsList.name.startsWith("_cycle/")).toBe(true);
  for (const name of Object.values(NOTIFICATIONS)) expect(name.startsWith("_cycle/")).toBe(true);
});

test("reads a seq off _meta, and only a positive integer", () => {
  expect(seqOf({ [META.seq]: 12 })).toBe(12);
  expect(seqOf({ [META.seq]: 0 })).toBeUndefined();
  expect(seqOf({ [META.seq]: "12" })).toBeUndefined();
  expect(seqOf(null)).toBeUndefined();
  expect(seqOf({})).toBeUndefined();
});

const png = (bytes: number) => ({
  type: "image",
  mimeType: "image/png",
  data: Buffer.alloc(bytes).toString("base64"),
});
const both = { image: {}, embeddedContext: {} };

test("a prompt of text and links is always fine; images and resources need the agent's say", () => {
  const text = [
    { type: "text", text: "hi" },
    { type: "resource_link", name: "a", uri: "file:///a" },
  ];
  expect(checkPrompt(text, undefined)).toBeUndefined();
  expect(checkPrompt([png(10)], undefined)).toEqual({ reason: "unsupported_block", index: 0 });
  expect(checkPrompt([png(10)], both)).toBeUndefined();
  const resource = { type: "resource", resource: { uri: "file:///a", text: "x" } };
  expect(checkPrompt([resource], { image: {} })).toEqual({ reason: "unsupported_block", index: 0 });
  expect(checkPrompt([resource], both)).toBeUndefined();
});

test("a prompt is refused whole, with the index of the block that is wrong", () => {
  expect(checkPrompt([], both)).toEqual({ reason: "empty" });
  expect(checkPrompt([{ type: "audio", data: "", mimeType: "audio/wav" }], both)).toEqual({
    reason: "unsupported_block",
    index: 0,
  });
  expect(
    checkPrompt(
      [
        { type: "text", text: "a" },
        { ...png(4), mimeType: "image/bmp" },
      ],
      both,
    ),
  ).toEqual({
    reason: "unsupported_media_type",
    index: 1,
  });
  expect(checkPrompt([{ ...png(4), data: "not base64!" }], both)).toEqual({
    reason: "invalid_base64",
    index: 0,
  });
  const pdf = (mimeType: string) => ({
    type: "resource",
    resource: { uri: "file:///a", mimeType, blob: Buffer.from("x").toString("base64") },
  });
  expect(checkPrompt([pdf("application/pdf")], both)).toBeUndefined();
  expect(checkPrompt([pdf("application/zip")], both)).toEqual({
    reason: "unsupported_media_type",
    index: 0,
  });
});

test("the limits are on decoded bytes: one block, the whole prompt, the block count", () => {
  expect(checkPrompt([png(PROMPT_LIMITS.blockBytes)], both)).toBeUndefined();
  expect(checkPrompt([png(PROMPT_LIMITS.blockBytes + 1)], both)).toEqual({
    reason: "block_too_large",
    index: 0,
  });
  const three = [png(5 * 1024 * 1024), png(5 * 1024 * 1024), png(3 * 1024 * 1024)];
  expect(checkPrompt(three, both)).toEqual({ reason: "prompt_too_large", index: 2 });
  const many = Array.from({ length: PROMPT_LIMITS.blocks + 1 }, () => ({
    type: "text",
    text: "a",
  }));
  expect(checkPrompt(many, both)).toEqual({ reason: "too_many_blocks" });
});

test("text counts against the limits too, in bytes and not in characters", () => {
  const text = (size: number) => ({ type: "text", text: "a".repeat(size) });
  expect(checkPrompt([text(PROMPT_LIMITS.blockBytes)], undefined)).toBeUndefined();
  expect(checkPrompt([text(PROMPT_LIMITS.blockBytes + 1)], undefined)).toEqual({
    reason: "block_too_large",
    index: 0,
  });
  // Three characters, nine bytes.
  expect(
    checkPrompt(
      [{ type: "text", text: "日本語".repeat(PROMPT_LIMITS.blockBytes / 9 + 1) }],
      undefined,
    ),
  ).toEqual({
    reason: "block_too_large",
    index: 0,
  });
  const many = [text(5 * 1024 * 1024), text(5 * 1024 * 1024), text(3 * 1024 * 1024)];
  expect(checkPrompt(many, undefined)).toEqual({ reason: "prompt_too_large", index: 2 });
});

test("a block missing what it must have is malformed, not a block of no bytes", () => {
  expect(checkPrompt([{ type: "text" }], undefined)).toEqual({
    reason: "malformed_block",
    index: 0,
  });
  expect(checkPrompt([{ type: "resource_link", name: "a" }], undefined)).toEqual({
    reason: "malformed_block",
    index: 0,
  });
  expect(checkPrompt([{ type: "resource", resource: { text: "x" } }], both)).toEqual({
    reason: "malformed_block",
    index: 0,
  });
  expect(checkPrompt([{ type: "image", mimeType: "image/png", data: "" }], both)).toEqual({
    reason: "invalid_base64",
    index: 0,
  });
});
