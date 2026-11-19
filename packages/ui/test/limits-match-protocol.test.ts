import { expect, test } from "bun:test";
import { IMAGE_TYPES, PROMPT_LIMITS, base64Bytes as protocolBase64Bytes } from "@cycle/protocol";
import { ATTACHMENT_LIMITS, base64Bytes, IMAGE_TYPES as uiImageTypes } from "../src/attachments.ts";

// The page may not import `@cycle/protocol`, so it keeps a copy of what a prompt may carry, to tell the person before
// anything is sent. These say the two copies are one: a change on one side alone fails here.

test("the page's limits are the daemon's", () => {
  expect(ATTACHMENT_LIMITS).toEqual(PROMPT_LIMITS);
});

test("the page takes the same image types as the daemon", () => {
  expect([...uiImageTypes]).toEqual([...IMAGE_TYPES]);
});

test("both count the bytes of a base64 text alike, with and without padding, and refuse the same texts", () => {
  const texts = [
    "",
    "AAAA",
    "AAA=",
    "AA==",
    "QUJD",
    "QUJDRA==",
    "QUJDREU=",
    "AAA", // not a multiple of four
    "AA=A", // padding in the middle
    "A===",
    "AAAA====",
    "AA\nAA", // not base64
    "AA AA",
    "////",
    "++++",
    "-_-_", // the URL-safe alphabet is not this one
  ];
  for (const text of texts)
    expect([text, base64Bytes(text)]).toEqual([text, protocolBase64Bytes(text)]);
});
