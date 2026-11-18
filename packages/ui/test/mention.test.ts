import { expect, test } from "bun:test";
import { mentionQuery, mentionRow } from "../src/mention.ts";

test("an @ at the start or after a space begins a name, up to the caret", () => {
  expect(mentionQuery("@")).toBe("");
  expect(mentionQuery("@src/ma")).toBe("src/ma");
  expect(mentionQuery("look at @ma")).toBe("ma");
  expect(mentionQuery("line one\nline two @a")).toBe("a");
});

test("an @ inside a word, a space in the name, or no @ at all, begins nothing", () => {
  expect(mentionQuery("mail me at a@b.c")).toBeUndefined();
  expect(mentionQuery("@src/main.ts ")).toBeUndefined();
  expect(mentionQuery("@a @")).toBe("");
  expect(mentionQuery("no at here")).toBeUndefined();
  expect(mentionQuery("@@")).toBeUndefined();
  expect(mentionQuery(`@${"a".repeat(81)}`)).toBeUndefined();
});

test("a file is shown by its name with its folder beside it, a folder with a slash", () => {
  expect(mentionRow("src/lib/a.ts", "file")).toEqual({ name: "a.ts", folder: "src/lib" });
  expect(mentionRow("README.md", "file")).toEqual({ name: "README.md", folder: "" });
  expect(mentionRow("src/lib", "folder")).toEqual({ name: "lib/", folder: "src" });
});
