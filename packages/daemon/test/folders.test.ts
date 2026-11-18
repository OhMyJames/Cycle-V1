import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FOLDER_LIST_LIMIT, listFolders } from "../src/folders.ts";
import { tempDir } from "./support.ts";

let root: string;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ dir: root, dispose } = await tempDir());
});
afterEach(async () => {
  await dispose();
});
const names = (list: { folders: { name: string }[] }) => list.folders.map((f) => f.name);

test("only folders are listed, by name without regard to case, and what starts with a dot only when asked for", async () => {
  await mkdir(join(root, "beta"));
  await mkdir(join(root, "Alpha"));
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "file.txt"), "x");
  const shown = await listFolders(root, false);
  expect(names(shown)).toEqual(["Alpha", "beta"]);
  expect(names(await listFolders(root, true))).toEqual([".hidden", "Alpha", "beta"]);
  expect(shown.truncated).toBe(false);
});

test("the real path, the folder above it, and the home folder are given", async () => {
  await mkdir(join(root, "a", "b"), { recursive: true });
  const list = await listFolders(join(root, "a", "b"), false);
  expect(list.path.endsWith(join("a", "b"))).toBe(true);
  expect(list.parent?.endsWith("a")).toBe(true);
  expect(list.home).toBe(homedir());
  expect((await listFolders("/", false)).parent).toBeNull();
});

test("a link to a folder is a folder, a link to a file or to nothing is not, and the path given is resolved", async () => {
  await mkdir(join(root, "real"));
  await mkdir(join(root, "real", "inside"));
  await writeFile(join(root, "file.txt"), "x");
  await symlink(join(root, "real"), join(root, "to-folder"));
  await symlink(join(root, "file.txt"), join(root, "to-file"));
  await symlink(join(root, "missing"), join(root, "to-nothing"));
  expect(names(await listFolders(root, false))).toEqual(["real", "to-folder"]);
  // Walking into the link lists the folder it stands for, under its real path.
  const through = await listFolders(join(root, "to-folder"), false);
  expect(names(through)).toEqual(["inside"]);
  expect(through.path.endsWith("real")).toBe(true);
});

test("with no path it is the home folder", async () => {
  const list = await listFolders(undefined, false);
  expect(list.home).toBe(homedir());
});

test("a path that is not absolute, not there, or not a folder is refused, and says why", async () => {
  await writeFile(join(root, "file.txt"), "x");
  await expect(listFolders("relative/path", false)).rejects.toMatchObject({ code: -32602 });
  await expect(listFolders(join(root, "gone"), false)).rejects.toMatchObject({ code: -32002 });
  await expect(listFolders(join(root, "file.txt"), false)).rejects.toMatchObject({
    code: -32602,
    data: { reason: "not_a_folder" },
  });
});

test("a folder with more than the limit gives the limit, and says so", async () => {
  for (let n = 0; n < 5; n += 1) await mkdir(join(root, `d${n}`));
  const list = await listFolders(root, false, 3);
  expect(names(list)).toEqual(["d0", "d1", "d2"]);
  expect(list.truncated).toBe(true);
  expect(FOLDER_LIST_LIMIT).toBe(1000);
});
