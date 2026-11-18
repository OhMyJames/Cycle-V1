import { expect, test } from "bun:test";
import type { Attachment } from "../src/attachments.ts";
import { createDraftStore, EMPTY_DRAFT, MAX_DRAFTS } from "../src/drafts.ts";

const image = (id: string): Attachment => ({
  id,
  name: `${id}.png`,
  type: "image/png",
  data: "AAAA",
  bytes: 3,
});

test("a session with nothing written has the one empty draft", () => {
  const drafts = createDraftStore();
  expect(drafts.get("a")).toBe(EMPTY_DRAFT);
  expect(drafts.get("b")).toBe(drafts.get("a"));
});

test("what is written to one session is not in another, and is there when it is asked for again", () => {
  const drafts = createDraftStore();
  drafts.update("a", (d) => ({ ...d, text: "half a sentence" }));
  drafts.update("b", (d) => ({ ...d, attachments: [image("x")] }));
  expect(drafts.get("a").text).toBe("half a sentence");
  expect(drafts.get("b").text).toBe("");
  expect(drafts.get("b").attachments.map((i) => i.id)).toEqual(["x"]);
});

test("a change is made on what the draft is now, so two images that were read together both stay", () => {
  const drafts = createDraftStore();
  drafts.update("a", (d) => ({ ...d, attachments: [...d.attachments, image("one")] }));
  drafts.update("a", (d) => ({ ...d, attachments: [...d.attachments, image("two")] }));
  expect(drafts.get("a").attachments.map((i) => i.id)).toEqual(["one", "two"]);
});

test("an empty draft is no draft, and a listener hears only of real changes", () => {
  const drafts = createDraftStore();
  let heard = 0;
  drafts.subscribe(() => {
    heard += 1;
  });
  drafts.update("a", (d) => d);
  expect(heard).toBe(0);
  drafts.update("a", (d) => ({ ...d, text: "x" }));
  drafts.update("a", (d) => ({ ...d, text: "" }));
  expect(heard).toBe(2);
  expect(drafts.get("a")).toBe(EMPTY_DRAFT);
});

test("sending clears the draft, and an image still being read for it is told it is too late", () => {
  const drafts = createDraftStore();
  drafts.update("a", (d) => ({ ...d, text: "send me" }));
  const reading = drafts.generation("a");
  drafts.sent("a");
  expect(drafts.get("a")).toBe(EMPTY_DRAFT);
  expect(drafts.generation("a")).not.toBe(reading);
  // Another session's reading is not affected.
  expect(drafts.generation("b")).toBe(0);
});

test("a deleted session, and a removed host, lose their drafts", () => {
  const drafts = createDraftStore();
  drafts.update("h1:a", (d) => ({ ...d, text: "1" }));
  drafts.update("h1:b", (d) => ({ ...d, text: "2" }));
  drafts.update("h2:a", (d) => ({ ...d, text: "3" }));
  drafts.forget("h1:a");
  expect(drafts.get("h1:a")).toBe(EMPTY_DRAFT);
  drafts.forgetHost("h1");
  expect(drafts.get("h1:b")).toBe(EMPTY_DRAFT);
  expect(drafts.get("h2:a").text).toBe("3");
});

test("only the most recently written drafts are kept", () => {
  const drafts = createDraftStore();
  for (let n = 0; n < MAX_DRAFTS + 3; n += 1) drafts.update(`s${n}`, (d) => ({ ...d, text: "x" }));
  expect(drafts.get("s0")).toBe(EMPTY_DRAFT);
  expect(drafts.get(`s${MAX_DRAFTS + 2}`).text).toBe("x");
  // Writing to one again makes it the newest.
  drafts.update("s5", (d) => ({ ...d, text: "y" }));
  drafts.update("another", (d) => ({ ...d, text: "z" }));
  expect(drafts.get("s5").text).toBe("y");
});
