import { expect, test } from "bun:test";
import type { Attachment } from "../src/attachments.ts";
import { type DraftStorage, DraftStore } from "../src/draft.ts";

const image = (id: string): Attachment => ({
  id,
  name: `${id}.png`,
  type: "image/png",
  data: "AAAA",
  bytes: 3,
});

const memoryStorage = (): DraftStorage & { keys: () => string[] } => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    keys: () => [...map.keys()],
  };
};

test("a session with nothing written has the one empty draft", () => {
  const drafts = new DraftStore(undefined);
  expect(drafts.get("a")).toBe(drafts.get("b"));
  expect(drafts.get("a").text).toBe("");
});

test("what is written to one session is not in another, and is there when it is asked for again", () => {
  const drafts = new DraftStore(undefined);
  drafts.setText("a", "half a sentence");
  drafts.setAttachments("b", [image("x")]);
  expect(drafts.get("a").text).toBe("half a sentence");
  expect(drafts.get("b").text).toBe("");
  expect(drafts.get("b").attachments.map((i) => i.id)).toEqual(["x"]);
});

test("sending clears the draft, and an image still being read for it is told it is too late", () => {
  const drafts = new DraftStore(undefined);
  drafts.setText("a", "send me");
  const reading = drafts.generation("a");
  drafts.clear("a");
  expect(drafts.get("a").text).toBe("");
  expect(drafts.generation("a")).not.toBe(reading);
  // Another session's reading is not affected.
  expect(drafts.generation("b")).toBe(0);
});

test("a deleted session, and a removed host, lose their drafts, in memory and in storage", () => {
  const storage = memoryStorage();
  const drafts = new DraftStore(storage);
  drafts.setText("h1:a", "1");
  drafts.setText("h1:b", "2");
  drafts.setText("h2:a", "3");
  drafts.forget("h1:a");
  expect(drafts.get("h1:a").text).toBe("");
  drafts.forgetHost("h1");
  expect(drafts.get("h1:b").text).toBe("");
  expect(drafts.get("h2:a").text).toBe("3");
  expect(storage.keys()).toEqual(["cycle:draft:h2:a"]);
  // A page that starts later finds only the other host's.
  const later = new DraftStore(storage);
  expect(later.get("h1:b").text).toBe("");
  expect(later.get("h2:a").text).toBe("3");
});

test("a host's drafts that this page never read are removed from storage too", () => {
  const storage = memoryStorage();
  storage.setItem("cycle:draft:h1:old", JSON.stringify({ text: "from before" }));
  storage.setItem("cycle:draft:h10:old", JSON.stringify({ text: "another host" }));
  const drafts = new DraftStore(storage);
  drafts.forgetHost("h1");
  expect(storage.keys()).toEqual(["cycle:draft:h10:old"]);
  expect(drafts.get("h1:old").text).toBe("");
});

test("a deleted session or removed host tells a read in flight it is too late, though nothing was ever sent", () => {
  const drafts = new DraftStore(undefined);
  const reading = drafts.generation("h1:a");
  drafts.forget("h1:a");
  expect(drafts.generation("h1:a")).not.toBe(reading);
  const other = drafts.generation("h1:b");
  const elsewhere = drafts.generation("h2:a");
  drafts.forgetHost("h1");
  expect(drafts.generation("h1:b")).not.toBe(other);
  expect(drafts.generation("h2:a")).toBe(elsewhere);
});
