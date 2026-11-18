import { expect, test } from "bun:test";
import { ATTACHMENT_LIMITS, base64Bytes, canAdd, viewOfImage } from "../src/attachments.ts";

// A 1x1 transparent PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("an image of a known type is drawn from a data URL, named by its uri, if it has one", () => {
  const view = viewOfImage({
    type: "image",
    data: PNG,
    mimeType: "image/png",
    uri: "file:///a/b/shot.png",
  });
  expect(view).toMatchObject({ ok: true, type: "image/png", name: "shot.png" });
  if (view.ok) expect(view.src.startsWith("data:image/png;base64,")).toBe(true);
  expect(viewOfImage({ type: "image", data: PNG, mimeType: "image/png" })).toMatchObject({
    name: "",
  });
});

test("svg, other types, and data that is not base64 are not drawn", () => {
  expect(viewOfImage({ data: PNG, mimeType: "image/svg+xml" })).toMatchObject({
    ok: false,
    reason: "unsupported",
  });
  expect(viewOfImage({ data: PNG, mimeType: "text/html" })).toMatchObject({
    ok: false,
    reason: "unsupported",
  });
  expect(viewOfImage({ data: '"><script>', mimeType: "image/png" })).toMatchObject({ ok: false });
  expect(viewOfImage({ mimeType: "image/png" })).toMatchObject({ ok: false });
  expect(viewOfImage({})).toMatchObject({ ok: false, type: "unknown" });
});

test("an image too big to hold in the page is not drawn", () => {
  const big = "A".repeat(20 * 1024 * 1024 + 4);
  expect(viewOfImage({ data: big, mimeType: "image/png" })).toMatchObject({
    ok: false,
    reason: "too-large",
  });
});

test("counts the bytes a base64 text decodes to", () => {
  expect(base64Bytes("")).toBe(0);
  expect(base64Bytes("TQ==")).toBe(1);
  expect(base64Bytes("TWE=")).toBe(2);
  expect(base64Bytes("TWFu")).toBe(3);
  expect(base64Bytes("abc")).toBeUndefined();
});

test("an image may be added until a limit of the prompt is reached", () => {
  expect(canAdd([], { name: "a.png", type: "image/png", bytes: 1000 })).toBeUndefined();
  expect(canAdd([], { name: "a.gif", type: "image/bmp", bytes: 1000 })).toEqual({
    reason: "type",
    name: "a.gif",
  });
  expect(
    canAdd([], { name: "big.png", type: "image/png", bytes: ATTACHMENT_LIMITS.blockBytes + 1 }),
  ).toEqual({
    reason: "block-too-large",
    name: "big.png",
  });
  const have = [{ bytes: 5_000_000 }, { bytes: 5_000_000 }];
  expect(canAdd(have, { name: "c.png", type: "image/png", bytes: 3_000_000 })).toEqual({
    reason: "prompt-too-large",
  });
  const many = Array.from({ length: ATTACHMENT_LIMITS.blocks - 1 }, () => ({ bytes: 1 }));
  expect(canAdd(many, { name: "d.png", type: "image/png", bytes: 1 })).toEqual({
    reason: "too-many",
  });
});
