import { readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { within } from "./trust-file.ts";

export type FileEntry = { path: string; kind: "file" | "folder" };

export type FileSearch = { entries: FileEntry[]; truncated: boolean };

/** What a search may spend (docs/protocol.md §8): a tree of any size is asked a question, not read whole. */
export const FILE_SEARCH_LIMITS = { entries: 50_000, ms: 2_000, results: 50 } as const;

const SKIPPED = new Set([".git", "node_modules"]);

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * How well a path matches, lower first, or undefined for none: its name starting with the query, its name holding it,
 * then its path holding it. A query with a `/` is looked for in the path only. Case does not matter.
 */
export const rank = (path: string, query: string): number | undefined => {
  const lower = path.toLowerCase();
  if (query.includes("/")) return lower.includes(query) ? 2 : undefined;
  const name = nameOf(lower);
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  return lower.includes(query) ? 2 : undefined;
};

/**
 * The files and folders under `cwd` that fit `query`, best first. Paths only, never contents. Everything found is under
 * the real path of `cwd`: symbolic links are neither followed nor listed, so no path can lead out of it. `.git` and
 * `node_modules` are not entered, and a name that starts with a dot is shown only to a query that has a dot in it. A
 * directory that cannot be read is skipped. A `cwd` that is not there has nothing in it.
 */
export const searchFiles = async (
  cwd: string,
  rawQuery: string,
  limit: number = 20,
  budget: { entries: number; ms: number } = FILE_SEARCH_LIMITS,
): Promise<FileSearch> => {
  const query = rawQuery.trim().toLowerCase();
  const wanted = Math.max(1, Math.min(limit, FILE_SEARCH_LIMITS.results));
  const withDots = query.includes(".");
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return { entries: [], truncated: false };
  }
  const started = Date.now();
  const found: { entry: FileEntry; rank: number }[] = [];
  let seen = 0;
  let truncated = false;
  // Breadth first, so that what is near the top is found before the budget runs out in the depths.
  let level = [root];
  walk: while (level.length > 0) {
    const next: string[] = [];
    for (const dir of level) {
      if (Date.now() - started > budget.ms) {
        truncated = true;
        break walk;
      }
      let items: import("node:fs").Dirent[];
      try {
        // A directory listed earlier may have been swapped for a link since (the agent runs commands here): it is
        // looked at again, and only a place that is still inside the folder is read.
        const here = await realpath(dir);
        if (!within(here, root)) continue;
        items = await readdir(here, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const item of items) {
        if (item.isSymbolicLink()) continue;
        const isDir = item.isDirectory();
        if (!isDir && !item.isFile()) continue;
        if (isDir && SKIPPED.has(item.name)) continue;
        if (item.name.startsWith(".") && !withDots) continue;
        seen += 1;
        if (seen > budget.entries) {
          truncated = true;
          break walk;
        }
        const full = join(dir, item.name);
        const path = relative(root, full).split(sep).join("/");
        // Defensive: a name cannot lead out of the root, but nothing here relies on that alone.
        if (path === "" || path.startsWith("../") || path === "..") continue;
        // With nothing typed only the top is shown, so there is nothing to look for below it.
        if (isDir && query !== "") next.push(full);
        if (query === "") {
          if (!path.includes("/"))
            found.push({ entry: { path, kind: isDir ? "folder" : "file" }, rank: isDir ? 0 : 1 });
          continue;
        }
        const r = rank(path, query);
        if (r !== undefined)
          found.push({ entry: { path, kind: isDir ? "folder" : "file" }, rank: r });
      }
    }
    level = next;
  }
  found.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.entry.path.length - b.entry.path.length ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return { entries: found.slice(0, wanted).map((f) => f.entry), truncated };
};
