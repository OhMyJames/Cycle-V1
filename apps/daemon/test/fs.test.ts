import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FS_LIMITS } from "@cycle/protocol";
import {
  characterBoundary,
  confine,
  listFolder,
  looksLikeText,
  readFile,
  segmentsOf,
} from "../src/fs.ts";
import { ignoredNames } from "../src/git.ts";
import { tempDir } from "./support.ts";

let work: string;
let outside: string;
let disposeWork: () => Promise<void>;
let disposeOutside: () => Promise<void>;
beforeEach(async () => {
  ({ dir: work, dispose: disposeWork } = await tempDir());
  ({ dir: outside, dispose: disposeOutside } = await tempDir());
  work = await realpath(work);
});
afterEach(async () => {
  await disposeWork();
  await disposeOutside();
});

const refusal = (reason: string) => ({ code: -32602, data: expect.objectContaining({ reason }) });

test("a path is relative and plain: nothing absolute, no dots, no empty segments, no NUL", () => {
  expect(segmentsOf("")).toEqual([]);
  expect(segmentsOf("src/a b.ts")).toEqual(["src", "a b.ts"]);
  for (const bad of ["/etc", "../x", "a/../b", "./a", "a//b", "a/", "a\0b"])
    expect(() => segmentsOf(bad)).toThrow(expect.objectContaining(refusal("invalid_path")));
});

test("a link may be walked inside the folder, never out of it, and nothing there is a refusal of its own", async () => {
  await mkdir(join(work, "src"));
  await symlink(join(work, "src"), join(work, "inner"));
  await symlink(outside, join(work, "away"));
  expect(await confine(work, "inner")).toEqual({ root: work, real: join(work, "src") });
  await expect(confine(work, "away")).rejects.toMatchObject(refusal("outside"));
  await expect(confine(work, "gone")).rejects.toMatchObject({ code: -32002 });
  await expect(confine(join(work, "nowhere"), "")).rejects.toMatchObject({ code: -32002 });
});

test("a folder lists one level, folders first and by name, with no .git and links as what they lead to", async () => {
  await mkdir(join(work, ".git"));
  await mkdir(join(work, "src"));
  await mkdir(join(work, "Docs"));
  await writeFile(join(work, "b.txt"), "hello");
  await writeFile(join(work, "A.md"), "#");
  await writeFile(join(work, ".env"), "X=1");
  await writeFile(join(work, "src", "deep.ts"), "x");
  await writeFile(join(outside, "secret"), "s");
  await symlink(join(work, "b.txt"), join(work, "link-in"));
  await symlink(join(outside, "secret"), join(work, "link-out"));
  await symlink(join(work, "missing"), join(work, "link-broken"));
  const list = await listFolder(work, "");
  expect(list).toEqual({
    root: work,
    path: "",
    truncated: false,
    entries: [
      { name: "Docs", kind: "folder" },
      { name: "src", kind: "folder" },
      { name: ".env", kind: "file", size: 3 },
      { name: "A.md", kind: "file", size: 1 },
      { name: "b.txt", kind: "file", size: 5 },
      { name: "link-broken", kind: "other", link: true },
      { name: "link-in", kind: "file", link: true, size: 5 },
      { name: "link-out", kind: "other", link: true },
    ],
  });
  expect((await listFolder(work, "src")).entries).toEqual([
    { name: "deep.ts", kind: "file", size: 1 },
  ]);
  await expect(listFolder(work, "b.txt")).rejects.toMatchObject(refusal("not_a_folder"));
});

test("what git ignores is marked for a trusted repository only, its trust taken where the repository starts", async () => {
  await mkdir(join(work, "node_modules"));
  await mkdir(join(work, "sub"));
  await writeFile(join(work, ".gitignore"), "node_modules/\n*.log\n:*\n");
  await writeFile(join(work, "a.log"), "");
  await writeFile(join(work, "b.txt"), "");
  // A name git would otherwise take for pathspec magic.
  await writeFile(join(work, ":(top)x"), "");
  await writeFile(join(work, "sub", "c.log"), "");
  const trusted = new Set<string>();
  const marks = (dir: string, names: readonly string[]) =>
    ignoredNames(dir, names, (repository) => trusted.has(repository));
  const ignoredIn = async (path: string) =>
    (await listFolder(work, path, marks)).entries.filter((e) => e.ignored).map((e) => e.name);
  // Not a repository yet: git says nothing.
  trusted.add(work);
  expect(await ignoredIn("")).toEqual([]);
  Bun.spawnSync(["git", "init", "-q"], { cwd: work });
  expect(await ignoredIn("")).toEqual(["node_modules", ":(top)x", "a.log"]);
  expect(await ignoredIn("sub")).toEqual(["c.log"]);
  // A trusted folder inside a repository that is not trusted: the repository's configuration is what git would read.
  trusted.clear();
  trusted.add(join(work, "sub"));
  expect(await ignoredIn("sub")).toEqual([]);
  // Not asked for at all: nothing is marked, not even "false".
  expect((await listFolder(work, "")).entries.every((e) => e.ignored === undefined)).toBe(true);
});

test("text is read a piece at a time, cut between characters", async () => {
  const piece = FS_LIMITS.textChunk;
  // A three-byte character straddles the end of the first piece.
  const text = `${"a".repeat(piece - 1)}€tail`;
  await writeFile(join(work, "big.txt"), text);
  const first = await readFile(work, "big.txt");
  expect(first).toMatchObject({ kind: "text", offset: 0, next: piece - 1 });
  if (first.kind !== "text" || first.next === null) throw new Error("expected more");
  const second = await readFile(work, "big.txt", first.next);
  expect(second).toMatchObject({ kind: "text", text: "€tail", next: null });
  expect(first.text + (second.kind === "text" ? second.text : "")).toBe(text);
  await expect(readFile(work, "big.txt", text.length * 2)).rejects.toMatchObject(
    refusal("invalid_offset"),
  );
  // Inside the euro sign: no piece starts there.
  await expect(readFile(work, "big.txt", piece)).rejects.toMatchObject(refusal("invalid_offset"));
  await writeFile(join(work, "empty"), "");
  expect(await readFile(work, "empty")).toMatchObject({ kind: "text", text: "", next: null });
});

test("an image comes whole, a large one by its size; anything not text by its size alone", async () => {
  await writeFile(join(work, "dot.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  expect(await readFile(work, "dot.png")).toMatchObject({
    kind: "image",
    mimeType: "image/png",
    data: "iVBORw==",
    size: 4,
  });
  await writeFile(join(work, "huge.jpg"), new Uint8Array(FS_LIMITS.image + 1));
  const huge = await readFile(work, "huge.jpg");
  expect(huge).toMatchObject({ kind: "image", tooLarge: true });
  expect("data" in huge).toBe(false);
  await writeFile(join(work, "app.bin"), new Uint8Array([1, 2, 0, 3]));
  expect(await readFile(work, "app.bin")).toEqual({
    kind: "binary",
    path: "app.bin",
    size: 4,
    mtimeMs: expect.any(Number),
  });
  await writeFile(join(work, "latin1.txt"), new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x21]));
  expect(await readFile(work, "latin1.txt")).toMatchObject({ kind: "binary" });
  await writeFile(join(work, "pic.svg"), "<svg/>");
  expect(await readFile(work, "pic.svg")).toMatchObject({ kind: "text", text: "<svg/>" });
  await mkdir(join(work, "dir"));
  await expect(readFile(work, "dir")).rejects.toMatchObject(refusal("not_a_file"));
});

test("a file reached through a link out of the folder is not read", async () => {
  await writeFile(join(outside, "secret"), "s");
  await symlink(join(outside, "secret"), join(work, "peek"));
  await expect(readFile(work, "peek")).rejects.toMatchObject(refusal("outside"));
});

test("UTF-8 is cut only between characters, and a character cut off at the end of the sniff is still text", () => {
  const euro = new TextEncoder().encode("a€"); // 61 e2 82 ac
  expect(characterBoundary(euro)).toBe(4);
  expect(characterBoundary(euro.subarray(0, 3))).toBe(1);
  expect(characterBoundary(euro.subarray(0, 2))).toBe(1);
  expect(characterBoundary(new TextEncoder().encode("abc"))).toBe(3);
  expect(looksLikeText(euro.subarray(0, 3))).toBe(true);
  expect(looksLikeText(new Uint8Array([0x61, 0]))).toBe(false);
});
