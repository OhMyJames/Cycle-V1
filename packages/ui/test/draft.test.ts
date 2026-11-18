import { expect, test } from "bun:test";
import {
  type Draft,
  DraftStore,
  draftOf,
  NOT_RECALLING,
  promptBlocks,
  recall,
  returnedId,
  sentTexts,
} from "../src/draft.ts";

/** A storage that is only a map, and can be told to fail. */
const memory = (fail = false) => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => {
      if (fail) throw new Error("denied");
      return items.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (fail) throw new Error("full");
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
};

const image = { id: "i", name: "a.png", type: "image/png" as const, data: "AAAA", bytes: 3 };

test("a draft is kept per session, and the same object until it changes", () => {
  const drafts = new DraftStore(undefined);
  expect(drafts.get("a").text).toBe("");
  drafts.setText("a", "hello");
  drafts.setText("b", "other");
  expect(drafts.get("a").text).toBe("hello");
  expect(drafts.get("a")).toBe(drafts.get("a"));
  expect(drafts.get("b").text).toBe("other");
});

test("the text outlasts a restart, and the images do not", () => {
  const storage = memory();
  const first = new DraftStore(storage);
  first.setText("local:s1", "half a thought");
  first.setAttachments("local:s1", [image]);
  const second = new DraftStore(storage);
  expect(second.get("local:s1")).toEqual({ text: "half a thought", attachments: [] });
  // No base64 went into the storage.
  expect([...storage.items.values()].join("")).not.toContain("AAAA");
});

test("sent or forgotten, nothing is left in the storage", () => {
  const storage = memory();
  const drafts = new DraftStore(storage);
  drafts.setText("k", "x");
  expect(storage.items.size).toBe(1);
  drafts.clear("k");
  expect(storage.items.size).toBe(0);
  drafts.setText("k", "y");
  drafts.markHandled("k", "id");
  drafts.clear("k");
  // What was handed back is still remembered, so it is not put in the box again.
  expect(drafts.handled("k", "id")).toBe(true);
  drafts.forget("k");
  expect(storage.items.size).toBe(0);
  expect(drafts.handled("k", "id")).toBe(false);
});

test("a storage that fails, or holds nonsense, does not break the draft", () => {
  const broken = new DraftStore(memory(true));
  broken.setText("k", "still here");
  expect(broken.get("k").text).toBe("still here");
  const nonsense = memory();
  nonsense.items.set("cycle:draft:k", "{not json");
  expect(new DraftStore(nonsense).get("k").text).toBe("");
});

test("subscribers hear of a change, and of nothing else", () => {
  const drafts = new DraftStore(undefined);
  let heard = 0;
  const stop = drafts.subscribe(() => heard++);
  drafts.setText("k", "a");
  drafts.setText("k", "a");
  expect(heard).toBe(1);
  stop();
  drafts.setText("k", "b");
  expect(heard).toBe(1);
});

test("what comes back goes in front of what was written since, as older words come first", () => {
  const drafts = new DraftStore(undefined);
  drafts.setText("k", "newer");
  drafts.setAttachments("k", [image]);
  drafts.restore("k", [
    [{ type: "text", text: "one" }],
    [
      { type: "text", text: "two" },
      { type: "image", data: "BBBB", mimeType: "image/png" },
      { type: "resource_link", name: "x", uri: "file:///x" },
    ],
  ]);
  const draft = drafts.get("k");
  expect(draft.text).toBe("one\n\ntwo\n\nnewer");
  expect(draft.attachments.map((a) => a.data)).toEqual(["BBBB", "AAAA"]);
});

test("a prompt's blocks become a draft, and a draft becomes blocks, text first", () => {
  const back = draftOf([
    { type: "text", text: "look" },
    { type: "image", data: "AAAA", mimeType: "image/gif" },
    { type: "image", data: "AAAA", mimeType: "image/svg+xml" },
  ]);
  expect(back.text).toBe("look");
  expect(back.attachments.map((a) => a.type)).toEqual(["image/gif"]);
  expect(promptBlocks(back)).toEqual([
    { type: "text", text: "look" },
    { type: "image", data: "AAAA", mimeType: "image/gif" },
  ]);
  expect(promptBlocks({ text: "  \n", attachments: [] } satisfies Draft)).toBeUndefined();
  expect(promptBlocks({ text: " ", attachments: [image] })).toEqual([
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
});

test("a hand-back has the id of what was in it", () => {
  expect(
    returnedId([
      { queueId: "a", prompt: [] },
      { queueId: "b", prompt: [] },
    ]),
  ).toBe("a|b");
});

test("up walks back through what was sent, and down returns to an empty box", () => {
  const sent = ["first", "second", "third"];
  const up1 = recall(sent, NOT_RECALLING, "", "up");
  expect(up1?.text).toBe("third");
  const up2 = recall(sent, up1?.state ?? NOT_RECALLING, "third", "up");
  expect(up2?.text).toBe("second");
  const up3 = recall(sent, up2?.state ?? NOT_RECALLING, "second", "up");
  const up4 = recall(sent, up3?.state ?? NOT_RECALLING, "first", "up");
  // Nothing before the first: the key is the caret's.
  expect(up4).toBeUndefined();
  const down = recall(sent, up2?.state ?? NOT_RECALLING, "second", "down");
  expect(down?.text).toBe("third");
  expect(recall(sent, down?.state ?? NOT_RECALLING, "third", "down")).toEqual({
    text: "",
    state: NOT_RECALLING,
  });
});

test("the arrows are the caret's in text that is being written", () => {
  const sent = ["old"];
  expect(recall(sent, NOT_RECALLING, "typing", "up")).toBeUndefined();
  expect(recall(sent, NOT_RECALLING, "", "down")).toBeUndefined();
  // Recalled, then edited: it is the person's text now, not a recalled one.
  const up = recall(sent, NOT_RECALLING, "", "up");
  expect(recall(sent, up?.state ?? NOT_RECALLING, "old, and more", "up")).toBeUndefined();
  expect(recall([], NOT_RECALLING, "", "up")).toBeUndefined();
});

test("what was sent is read from the conversation: the person's messages with words in them", () => {
  expect(
    sentTexts([
      { kind: "user", blocks: [{ type: "text", text: "a" }] },
      { kind: "agent", blocks: [{ type: "text", text: "no" }] },
      { kind: "user", blocks: [{ type: "image", data: "AAAA" }] },
      { kind: "user", blocks: [{ type: "text", text: "b" }] },
    ]),
  ).toEqual(["a", "b"]);
});
