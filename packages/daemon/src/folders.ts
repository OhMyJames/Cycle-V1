import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { FolderList } from "@cycle/protocol";
import { INVALID_PARAMS, RESOURCE_NOT_FOUND, RpcError } from "./errors.ts";

/** How many folders a listing gives (docs/protocol.md §8): a folder of any size is asked a question, not read whole. */
export const FOLDER_LIST_LIMIT = 1_000;
/** How many entries of one folder are looked at, and how many links are looked into at once. */
const EXAMINED = 20_000;
const AT_ONCE = 64;

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.toLowerCase() < b.name.toLowerCase()
    ? -1
    : a.name.toLowerCase() > b.name.toLowerCase()
      ? 1
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0;

const unreadable = (path: string) =>
  new RpcError(INVALID_PARAMS, "The folder cannot be read", { path, reason: "unreadable" });
const notAFolder = (path: string) =>
  new RpcError(INVALID_PARAMS, "That is not a folder", { path, reason: "not_a_folder" });

/**
 * The folders in `path` (the home folder when it is not given), by name: names only, never files or contents. A link to
 * a folder is a folder, so that one can walk into `~/work`; a link to anything else, and anything that cannot be looked
 * at, is not listed. Names that start with a dot only when `hidden`. At most `EXAMINED` entries are looked at (links in
 * batches): past that the listing is cut, and says so.
 */
export const listFolders = async (
  path: string | undefined,
  hidden: boolean,
  limit: number = FOLDER_LIST_LIMIT,
  /** The home folder: the daemon's user's, unless a test says another. */
  home: string = homedir(),
): Promise<FolderList> => {
  const wanted = path ?? home;
  if (wanted.includes("\0")) throw new RpcError(INVALID_PARAMS, "The path is not valid", {});
  if (!isAbsolute(wanted)) {
    throw new RpcError(INVALID_PARAMS, "The path must be absolute", { path: wanted });
  }
  let real: string;
  try {
    real = await realpath(wanted);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new RpcError(RESOURCE_NOT_FOUND, "No such folder", { path: wanted });
    // A path through a file (/etc/hosts/x) leads to no folder.
    if (code === "ENOTDIR") throw notAFolder(wanted);
    throw unreadable(wanted);
  }
  let items: import("node:fs").Dirent[];
  try {
    if (!(await stat(real)).isDirectory()) throw notAFolder(wanted);
    items = await readdir(real, { withFileTypes: true });
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw unreadable(wanted);
  }
  let cut = items.length > EXAMINED;
  const examined = (cut ? items.slice(0, EXAMINED) : items).filter(
    (item) => hidden || !item.name.startsWith("."),
  );
  const folders: { name: string }[] = [];
  const links: import("node:fs").Dirent[] = [];
  for (const item of examined) {
    if (item.isDirectory()) folders.push({ name: item.name });
    else if (item.isSymbolicLink()) links.push(item);
  }
  for (let at = 0; at < links.length; at += AT_ONCE) {
    const batch = links.slice(at, at + AT_ONCE);
    const results = await Promise.all(
      batch.map(async (item) => {
        try {
          return (await stat(join(real, item.name))).isDirectory();
        } catch {
          // A link to nothing, or to what cannot be looked at: not a folder to walk into.
          return false;
        }
      }),
    );
    batch.forEach((item, n) => {
      if (results[n] === true) folders.push({ name: item.name });
    });
  }
  folders.sort(byName);
  if (folders.length > limit) cut = true;
  const parent = dirname(real);
  return {
    path: real,
    parent: parent === real ? null : parent,
    home,
    folders: folders.slice(0, limit),
    truncated: cut,
  };
};
