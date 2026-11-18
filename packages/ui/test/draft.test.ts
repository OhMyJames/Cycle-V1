import { expect, test } from "bun:test";
import {
  type Draft,
  DraftStore,
  draftOf,
  fileUri,
  type Mention,
  mentionText,
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
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
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
  expect(second.get("local:s1")).toEqual({
    text: "half a thought",
    attachments: [],
    mentions: [],
  });
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
  expect(
    promptBlocks({ text: "  \n", attachments: [], mentions: [] } satisfies Draft),
  ).toBeUndefined();
  expect(promptBlocks({ text: " ", attachments: [image], mentions: [] })).toEqual([
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

const file = (path: string, root = "/work"): Mention => ({
  path,
  kind: "file",
  uri: fileUri(root, path, "file"),
  name: path.slice(path.lastIndexOf("/") + 1),
});
const folder = (path: string, root = "/work"): Mention => ({
  path,
  kind: "folder",
  uri: fileUri(root, path, "folder"),
  name: path.slice(path.lastIndexOf("/") + 1),
});

test("a mention is the readable @path in the text, and a link beside it for the agent", () => {
  const draft: Draft = {
    text: "look at @src/main.ts and @docs/ please",
    attachments: [],
    mentions: [file("src/main.ts"), folder("docs")],
  };
  expect(promptBlocks(draft)).toEqual([
    { type: "text", text: "look at @src/main.ts and @docs/ please" },
    {
      type: "resource_link",
      name: "main.ts",
      uri: "file:///work/src/main.ts",
      _meta: { "cycle/mention": "src/main.ts" },
    },
    {
      type: "resource_link",
      name: "docs",
      uri: "file:///work/docs/",
      _meta: { "cycle/mention": "docs" },
    },
  ]);
});

test("a mention the words no longer say is not sent, and one picked twice is sent once", () => {
  const draft: Draft = {
    text: "only @a.ts remains",
    attachments: [],
    mentions: [file("a.ts"), file("b.ts"), file("a.ts")],
  };
  const links = (promptBlocks(draft) ?? []).filter((b) => b.type === "resource_link");
  expect(links.map((b) => (b as { name: string }).name)).toEqual(["a.ts"]);
  const store = new DraftStore(undefined);
  store.addMention("k", file("a.ts"));
  store.addMention("k", file("a.ts"));
  expect(store.get("k").mentions).toHaveLength(1);
});

test("links share the block limit with the images: the words say it all when there is no room", () => {
  const mentions = Array.from({ length: 40 }, (_, i) => file(`f${i}.ts`));
  const text = mentions.map(mentionText).join(" ");
  const blocks = promptBlocks({ text, attachments: [image], mentions }) ?? [];
  expect(blocks).toHaveLength(32);
  expect(blocks[0]).toEqual({ type: "text", text });
});

test("an address is made of the root and the path, each part kept apart from the others' characters", () => {
  expect(fileUri("/work", "src/a b.ts", "file")).toBe("file:///work/src/a%20b.ts");
  expect(fileUri("/work/", "dir (1)/x#1?.ts", "file")).toBe("file:///work/dir%20(1)/x%231%3F.ts");
  expect(fileUri("/home/u", "lib", "folder")).toBe("file:///home/u/lib/");
});

test("a link that comes back is a mention again, and links that were not mentions are left out", () => {
  const sent = promptBlocks({
    text: "see @src/main.ts",
    attachments: [],
    mentions: [file("src/main.ts")],
  });
  const back = draftOf(sent ?? []);
  expect(back.text).toBe("see @src/main.ts");
  expect(back.mentions).toEqual([file("src/main.ts")]);
  expect(draftOf([{ type: "resource_link", name: "x", uri: "file:///x" }]).mentions).toEqual([]);
});
