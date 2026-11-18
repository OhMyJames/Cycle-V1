import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { INVALID_PARAMS, RESOURCE_NOT_FOUND, RpcError } from "./errors.ts";

/** How many folders a listing gives (docs/protocol.md §8): a folder of any size is asked a question, not read whole. */
export const FOLDER_LIST_LIMIT = 1_000;

export type FolderList = {
  /** The real path of what was listed. */
  path: string;
  parent: string | null;
  home: string;
  folders: { name: string }[];
  truncated: boolean;
};

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

/**
 * The folders in `path` (the home folder when it is not given), by name: names only, never files or contents. A link to
 * a folder is a folder, so that one can walk into `~/work`; a link to anything else, and anything that cannot be looked
 * at, is not listed. Names that start with a dot only when `hidden`.
 */
export const listFolders = async (
  path: string | undefined,
  hidden: boolean,
  limit: number = FOLDER_LIST_LIMIT,
): Promise<FolderList> => {
  const home = homedir();
  const wanted = path ?? home;
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
    throw new RpcError(INVALID_PARAMS, "The folder cannot be read", {
      path: wanted,
      reason: "unreadable",
    });
  }
  let items: import("node:fs").Dirent[];
  try {
    if (!(await stat(real)).isDirectory()) {
      throw new RpcError(INVALID_PARAMS, "That is not a folder", {
        path: wanted,
        reason: "not_a_folder",
      });
    }
    items = await readdir(real, { withFileTypes: true });
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw new RpcError(INVALID_PARAMS, "The folder cannot be read", {
      path: wanted,
      reason: "unreadable",
    });
  }
  const folders: { name: string }[] = [];
  for (const item of items) {
    if (!hidden && item.name.startsWith(".")) continue;
    if (item.isDirectory()) folders.push({ name: item.name });
    else if (item.isSymbolicLink()) {
      try {
        if ((await stat(join(real, item.name))).isDirectory()) folders.push({ name: item.name });
      } catch {
        // A link to nothing, or to what cannot be looked at: not a folder to walk into.
      }
    }
  }
  folders.sort(byName);
  const parent = dirname(real);
  return {
    path: real,
    parent: parent === real ? null : parent,
    home,
    folders: folders.slice(0, limit),
    truncated: folders.length > limit,
  };
};
