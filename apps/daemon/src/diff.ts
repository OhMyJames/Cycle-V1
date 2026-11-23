// The Diff tab's workspace view (docs/protocol.md §8 "工作区的改动"): the session's folder against HEAD, as git says it,
// only in a repository the person trusts (.agents/notes/2026-11-22-files-and-diff-sources.md). Paths are relative to the
// session's folder, and only what is inside it is looked at.
import { realpath, stat } from "node:fs/promises";
import {
  DIFF_LIMITS,
  type DiffFile,
  type DiffPatch,
  type DiffStatus,
  FS_LIMITS,
} from "@cycle/protocol";
import { INTERNAL_ERROR, INVALID_PARAMS, RESOURCE_NOT_FOUND, RpcError } from "./errors.ts";
import { confine, looksLikeText, readAt, segmentsOf, withFileInside } from "./fs.ts";
import { type GitOptions, type GitResult, repositoryOf, runGit } from "./git.ts";

/** What a diff waits for: a large working tree takes a while to compare. */
const TIME_LIMIT_MS = 10_000;

/** Git's tree with nothing in it: what a repository with no commit yet is compared with. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Never an outside program to compare or to turn a file into text: only git's own diff. */
const DIFF = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative"];

const failed = (what: string) =>
  new RpcError(INTERNAL_ERROR, "Git could not say what changed", { detail: what });

type Place = { real: string; repository: string };

/** The real folder and its repository, or why there is nothing to compare. */
const placeOf = async (
  cwd: string,
  trusts: (repository: string) => boolean,
): Promise<Place | { state: "not_git" } | { state: "untrusted"; repository: string }> => {
  let real: string;
  try {
    real = await realpath(cwd);
  } catch {
    throw new RpcError(RESOURCE_NOT_FOUND, "The session's folder is not there", { path: cwd });
  }
  const repository = await repositoryOf(real);
  if (repository === undefined) return { state: "not_git" };
  if (!trusts(repository)) return { state: "untrusted", repository };
  return { real, repository };
};

const git = async (
  place: Place,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> => {
  const result = await runGit(place.real, place.repository, args, {
    literal: true,
    timeoutMs: TIME_LIMIT_MS,
    ...options,
  });
  if (result === undefined) throw failed(`git ${args[0]} did not finish`);
  return result;
};

const fields = (bytes: Uint8Array): string[] =>
  new TextDecoder()
    .decode(bytes)
    .split("\0")
    .filter((field) => field !== "");

/** The commit HEAD names, or null in a repository with no commit yet. */
const headOf = async (place: Place): Promise<string | null> => {
  const result = await git(place, ["rev-parse", "--verify", "-q", "HEAD"]);
  return result.code === 0 ? new TextDecoder().decode(result.stdout).trim() : null;
};

/** How long the lines of untracked files are counted, and how many at once: past that they are listed uncounted. */
const COUNTING = { ms: 2_000, atOnce: 16 } as const;

/**
 * The lines of a file that is not tracked, counted as added, read through the Files tab's guards: nothing when it is
 * too large to count, cannot be read, or is no longer a plain file inside the folder.
 */
const linesOf = (cwd: string, path: string): Promise<{ lines?: number; binary?: boolean }> =>
  withFileInside(cwd, path, async (handle, opened) => {
    if (opened.size > DIFF_LIMITS.patch) return {};
    const bytes = await readAt(handle, 0, opened.size);
    if (!looksLikeText(bytes.subarray(0, FS_LIMITS.sniff))) return { binary: true };
    let lines = 0;
    for (const byte of bytes) if (byte === 0x0a) lines += 1;
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) lines += 1;
    return { lines };
  }).catch(() => ({}));

const STATUS: Record<string, DiffFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "modified",
};

/** Which files of the session's folder differ from HEAD, and by how many lines. */
export const workspaceStatus = async (
  cwd: string,
  trusts: (repository: string) => boolean,
): Promise<DiffStatus> => {
  const place = await placeOf(cwd, trusts);
  if ("state" in place) return place;
  const head = await headOf(place);
  const base = head ?? EMPTY_TREE;
  // One pass over the tree for what changed and by how much (`--raw` then `--numstat`), one for what is not tracked.
  const [changes, untracked] = await Promise.all([
    git(place, [...DIFF, "--raw", "--numstat", "-z", base, "--", "."]),
    git(place, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
  ]);
  for (const result of [changes, untracked])
    if (result.code !== 0) throw failed(`git exited with ${result.code}`);
  const files = new Map<string, DiffFile>();
  const tokens = fields(changes.stdout);
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] as string;
    if (token.startsWith(":")) {
      // `:mode mode sha sha S`, then the path.
      const path = tokens[at + 1];
      at += 1;
      if (path === undefined) break;
      const letter = token.slice(token.lastIndexOf(" ") + 1, token.lastIndexOf(" ") + 2);
      files.set(path, { path, status: STATUS[letter] ?? "modified" });
      continue;
    }
    // `added\tdeleted\tpath`, with `-` for both when the file is binary.
    const [plus, minus, ...rest] = token.split("\t");
    const file = files.get(rest.join("\t"));
    if (file === undefined) continue;
    if (plus === "-" || minus === "-") file.binary = true;
    else {
      file.additions = Number(plus);
      file.deletions = Number(minus);
    }
  }
  // A repository inside, not tracked, is listed as a folder (`lib/`): it is shown by its name, and has no lines.
  for (const listed of fields(untracked.stdout)) {
    const path = listed.replace(/\/+$/, "");
    files.set(path, { path, status: "untracked" });
  }
  const sorted = [...files.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const shown = sorted.slice(0, DIFF_LIMITS.files);
  // Lines of the untracked files shown, a few at a time, for as long as that takes no more than a moment.
  const counting = shown.filter((file) => file.status === "untracked");
  const until = Date.now() + COUNTING.ms;
  for (let at = 0; at < counting.length && Date.now() < until; at += COUNTING.atOnce) {
    await Promise.all(
      counting.slice(at, at + COUNTING.atOnce).map(async (file) => {
        const counted = await linesOf(cwd, file.path);
        if (counted.binary === true) file.binary = true;
        else if (counted.lines !== undefined) {
          file.additions = counted.lines;
          file.deletions = 0;
        }
      }),
    );
  }
  return {
    state: "ok",
    head,
    files: shown,
    truncated: sorted.length > DIFF_LIMITS.files,
  };
};

/** Cut a patch at the end of its last whole line. */
const wholeLines = (text: string): string => {
  const end = text.lastIndexOf("\n");
  return end === -1 ? "" : text.slice(0, end + 1);
};

/** A whole new file as a patch, as git writes one: every line added. */
const added = (path: string, text: string): string => {
  if (text === "") return "";
  const ended = text.endsWith("\n");
  const lines = (ended ? text.slice(0, -1) : text).split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ...(ended ? [] : ["\\ No newline at end of file"]),
    "",
  ].join("\n");
};

/** One file's patch against the same base as the status: a file not tracked is all added. */
export const workspaceFile = async (
  cwd: string,
  path: string,
  trusts: (repository: string) => boolean,
): Promise<DiffPatch> => {
  if (path === "")
    throw new RpcError(INVALID_PARAMS, "The path is not valid", { path, reason: "invalid_path" });
  segmentsOf(path);
  // Only a plain file has a patch: not a folder (a repository inside, listed untracked), not a pipe or a device.
  const target = await confine(cwd, path).catch(() => undefined);
  const kind = target !== undefined ? await stat(target.real).catch(() => undefined) : undefined;
  if (kind !== undefined && !kind.isFile())
    throw new RpcError(INVALID_PARAMS, "That is not a file", { path, reason: "not_a_file" });
  const place = await placeOf(cwd, trusts);
  if ("state" in place)
    throw new RpcError(INVALID_PARAMS, "There is no workspace diff here", {
      path,
      reason: place.state,
    });
  const untracked = await git(place, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    path,
  ]);
  if (untracked.code !== 0) throw failed(`git exited with ${untracked.code}`);
  if (fields(untracked.stdout).includes(path))
    // Read as the Files tab reads: confined, not through a link, not a pipe, checked again once open.
    return withFileInside(cwd, path, async (handle, opened) => {
      const bytes = await readAt(handle, 0, Math.min(opened.size, DIFF_LIMITS.patch));
      if (!looksLikeText(bytes.subarray(0, FS_LIMITS.sniff)))
        return { path, patch: "", truncated: false, binary: true };
      const text = new TextDecoder().decode(bytes);
      const truncated = opened.size > DIFF_LIMITS.patch;
      return {
        path,
        patch: added(path, truncated ? wholeLines(text) : text),
        truncated,
        binary: false,
      };
    });
  const base = (await headOf(place)) ?? EMPTY_TREE;
  const result = await git(place, [...DIFF, base, "--", path], { maxBytes: DIFF_LIMITS.patch });
  if (!result.cut && result.code !== 0) throw failed(`git exited with ${result.code}`);
  const text = new TextDecoder().decode(result.stdout);
  const binary = !text.includes("\n@@ ") && /^Binary files /m.test(text);
  return {
    path,
    patch: binary ? "" : result.cut ? wholeLines(text) : text,
    truncated: result.cut,
    binary,
  };
};
