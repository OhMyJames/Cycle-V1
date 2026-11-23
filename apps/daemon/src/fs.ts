// The Files tab's reading of a session's folder (docs/protocol.md §8 "浏览和预览文件"): one folder at a time, a file a
// piece at a time, read-only, and never outside the folder. Every request finds the real path again: the agent runs
// commands here, so a link looked at a moment ago may lead elsewhere now.
import { constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { FS_LIMITS, type FsEntry, type FsList, type FsRead } from "@cycle/protocol";
import { INVALID_PARAMS, RESOURCE_NOT_FOUND, RpcError } from "./errors.ts";
import { within } from "./trust-file.ts";

/** How many links are looked into at once. */
const AT_ONCE = 64;

const IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const refused = (path: string, reason: string, message: string) =>
  new RpcError(INVALID_PARAMS, message, { path, reason });
const notFound = (path: string) =>
  new RpcError(RESOURCE_NOT_FOUND, "No such file or folder", { path });

/** The segments of a path relative to the folder, or a refusal: absolute, `.`, `..`, an empty segment, a NUL. */
export const segmentsOf = (path: string): string[] => {
  if (path === "") return [];
  const segments = path.split("/");
  if (path.includes("\0") || segments.some((s) => s === "" || s === "." || s === ".."))
    throw refused(path, "invalid_path", "The path is not valid");
  return segments;
};

/** The real paths of the folder and of `path` in it, or a refusal when `path` leads out of it. */
export const confine = async (
  cwd: string,
  path: string,
): Promise<{ root: string; real: string }> => {
  const segments = segmentsOf(path);
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    throw notFound(path);
  }
  let real: string;
  try {
    real = await realpath(join(root, ...segments));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A path through a file (a.txt/b) leads to nothing.
    if (code === "ENOENT" || code === "ENOTDIR") throw notFound(path);
    throw refused(path, "unreadable", "It cannot be read");
  }
  if (!within(real, root)) throw refused(path, "outside", "That is outside the session's folder");
  return { root, real };
};

const byName = (a: FsEntry, b: FsEntry): number => {
  if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
  const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
  if (x !== y) return x < y ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/** What one entry is, looked at through any link: a link out of the folder, or to nothing, is `other`. */
const entryOf = async (dir: string, root: string, item: Dirent): Promise<FsEntry> => {
  const full = join(dir, item.name);
  if (item.isDirectory()) return { name: item.name, kind: "folder" };
  if (item.isFile()) {
    const size = await stat(full).then(
      (s) => s.size,
      () => undefined,
    );
    return size === undefined
      ? { name: item.name, kind: "file" }
      : { name: item.name, kind: "file", size };
  }
  if (!item.isSymbolicLink()) return { name: item.name, kind: "other" };
  try {
    const target = await realpath(full);
    if (!within(target, root)) return { name: item.name, kind: "other", link: true };
    const s = await stat(target);
    if (s.isDirectory()) return { name: item.name, kind: "folder", link: true };
    if (s.isFile()) return { name: item.name, kind: "file", link: true, size: s.size };
  } catch {
    // To nothing, or to what cannot be looked at.
  }
  return { name: item.name, kind: "other", link: true };
};

/**
 * One folder of the session's folder: its entries, folders first, by name. `.git` is left out. `ignored` names which of
 * them git ignores, when that can be known (a trusted folder): without it nothing is marked.
 */
export const listFolder = async (
  cwd: string,
  path: string,
  ignored?: (dir: string, names: readonly string[]) => Promise<Set<string>>,
): Promise<FsList> => {
  const { root, real } = await confine(cwd, path);
  let items: Dirent[];
  try {
    const before = await stat(real);
    if (!before.isDirectory()) throw refused(path, "not_a_folder", "That is not a folder");
    items = await readdir(real, { withFileTypes: true });
    await stillInside(root, real, before, path);
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw refused(path, "unreadable", "It cannot be read");
  }
  let truncated = items.length > FS_LIMITS.examined;
  const examined = (truncated ? items.slice(0, FS_LIMITS.examined) : items).filter(
    (item) => item.name !== ".git",
  );
  const entries: FsEntry[] = [];
  for (let at = 0; at < examined.length; at += AT_ONCE) {
    entries.push(
      ...(await Promise.all(
        examined.slice(at, at + AT_ONCE).map((item) => entryOf(real, root, item)),
      )),
    );
  }
  entries.sort(byName);
  if (entries.length > FS_LIMITS.entries) truncated = true;
  const given = entries.slice(0, FS_LIMITS.entries);
  if (ignored !== undefined) {
    const names = await ignored(
      real,
      given.map((e) => e.name),
    );
    for (const entry of given) if (names.has(entry.name)) entry.ignored = true;
  }
  // The folder as the session has it, as `_cycle/files/search` says it: paths a client joins agree.
  return { root: cwd, path, entries: given, truncated };
};

/** Where a piece of UTF-8 may end: not inside a character, unless the whole piece is one unfinished character. */
export const characterBoundary = (bytes: Uint8Array): number => {
  const end = bytes.length;
  // Back over the continuation bytes (10xxxxxx) to the start of the last character: at most three of them.
  let start = end - 1;
  while (start > 0 && end - start < 4 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start -= 1;
  const lead = bytes[start] ?? 0;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (start + length <= end) return end;
  return start > 0 ? start : end;
};

/** Text, if the first bytes of a file are UTF-8 with no NUL; a character cut off at their end does not count. */
export const looksLikeText = (head: Uint8Array): boolean => {
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
};

/**
 * What was opened or listed is what was checked: still inside the folder, and the same thing (`dev` and `ino`) that the
 * real path names now, not something a link swapped in meanwhile led to. The agent runs commands here.
 */
const stillInside = async (root: string, real: string, opened: Stats, path: string) => {
  const again = await realpath(real).catch(() => undefined);
  const now = again === undefined ? undefined : await stat(again).catch(() => undefined);
  if (
    again === undefined ||
    now === undefined ||
    !within(again, root) ||
    now.dev !== opened.dev ||
    now.ino !== opened.ino
  )
    throw refused(path, "outside", "That is outside the session's folder");
};

const readAt = async (
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Uint8Array> => {
  const buffer = new Uint8Array(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
};

/**
 * A file of the session's folder, as the Files tab shows it: text a piece at a time from `offset`, an image whole (when
 * it is not too large), anything else only by its size. One handle, opened without following a last link and checked
 * after it is open, is what every byte comes through.
 */
export const readFile = async (cwd: string, path: string, offset = 0): Promise<FsRead> => {
  const { root, real } = await confine(cwd, path);
  let handle: FileHandle;
  try {
    // Not blocking: a pipe would wait for a writer before it even opened.
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw notFound(path);
    // A link put where the file was after it was looked at.
    if (code === "ELOOP") throw refused(path, "outside", "That is outside the session's folder");
    throw refused(path, "unreadable", "It cannot be read");
  }
  try {
    const opened = await handle.stat();
    // A pipe or a device would never end: only plain files are read.
    if (!opened.isFile()) throw refused(path, "not_a_file", "That is not a file");
    await stillInside(root, real, opened, path);
    const { size, mtimeMs } = opened;
    const head = { path, size, mtimeMs };
    const name = path.slice(path.lastIndexOf("/") + 1);
    const mimeType = name.includes(".")
      ? IMAGES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()]
      : undefined;
    if (mimeType !== undefined) {
      if (size > FS_LIMITS.image) return { ...head, kind: "image", mimeType, tooLarge: true };
      const bytes = await readAt(handle, 0, size);
      return { ...head, kind: "image", mimeType, data: Buffer.from(bytes).toString("base64") };
    }
    if (!looksLikeText(await readAt(handle, 0, Math.min(size, FS_LIMITS.sniff))))
      return { ...head, kind: "binary" };
    if (offset > size) throw refused(path, "invalid_offset", "The offset is past the end");
    const bytes = await readAt(handle, offset, Math.min(FS_LIMITS.textChunk, size - offset));
    // A piece starts where a character does: the offsets given out are such places.
    if (offset > 0 && bytes.length > 0 && ((bytes[0] ?? 0) & 0xc0) === 0x80)
      throw refused(path, "invalid_offset", "The offset is inside a character");
    const end = offset + bytes.length < size ? characterBoundary(bytes) : bytes.length;
    // Past the first bytes a file may stop being UTF-8: what is not becomes U+FFFD, it is not refused.
    const text = new TextDecoder().decode(bytes.subarray(0, end));
    const next = offset + end < size ? offset + end : null;
    return { ...head, kind: "text", text, offset, next };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw refused(path, "unreadable", "It cannot be read");
  } finally {
    await handle.close();
  }
};
