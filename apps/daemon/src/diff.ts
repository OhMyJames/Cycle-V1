// The Diff tab's workspace view (docs/protocol.md §8 "工作区的改动"): the session's folder against HEAD, as git says it,
// only in a repository the person trusts (.agents/notes/2026-11-22-files-and-diff-sources.md). Paths are relative to the
// session's folder, and only what is inside it is looked at.
import { open, realpath } from "node:fs/promises";
import { DIFF_LIMITS, type DiffFile, type DiffPatch, type DiffStatus } from "@cycle/protocol";
import { INTERNAL_ERROR, INVALID_PARAMS, RESOURCE_NOT_FOUND, RpcError } from "./errors.ts";
import { confine, looksLikeText, segmentsOf } from "./fs.ts";
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

/** The lines of a file that is not tracked, counted as added: undefined when it is too large to count. */
const linesOf = async (path: string): Promise<{ lines?: number; binary?: boolean }> => {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size > DIFF_LIMITS.patch) return {};
    const bytes = new Uint8Array(size);
    await handle.read(bytes, 0, size, 0);
    if (!looksLikeText(bytes.subarray(0, 8 * 1024))) return { binary: true };
    let lines = 0;
    for (const byte of bytes) if (byte === 0x0a) lines += 1;
    if (size > 0 && bytes[size - 1] !== 0x0a) lines += 1;
    return { lines };
  } finally {
    await handle.close();
  }
};

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
  const [names, numbers, untracked] = await Promise.all([
    git(place, [...DIFF, "--name-status", "-z", base, "--", "."]),
    git(place, [...DIFF, "--numstat", "-z", base, "--", "."]),
    git(place, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
  ]);
  for (const result of [names, numbers, untracked])
    if (result.code !== 0) throw failed(`git exited with ${result.code}`);
  const files = new Map<string, DiffFile>();
  const named = fields(names.stdout);
  for (let at = 0; at + 1 < named.length; at += 2) {
    const path = named[at + 1] as string;
    files.set(path, { path, status: STATUS[(named[at] as string)[0] ?? ""] ?? "modified" });
  }
  // `added\tdeleted\tpath`, with `-` for both when the file is binary.
  for (const field of fields(numbers.stdout)) {
    const [added, deleted, ...rest] = field.split("\t");
    const file = files.get(rest.join("\t"));
    if (file === undefined) continue;
    if (added === "-" || deleted === "-") file.binary = true;
    else {
      file.additions = Number(added);
      file.deletions = Number(deleted);
    }
  }
  for (const path of fields(untracked.stdout)) {
    const file: DiffFile = { path, status: "untracked" };
    // Through the same checks as the Files tab: an untracked link out of the folder is not followed.
    const counted = await confine(cwd, path)
      .then(({ real }) => linesOf(real))
      .catch(() => ({}) as { lines?: number; binary?: boolean });
    if (counted.binary === true) file.binary = true;
    else if (counted.lines !== undefined) {
      file.additions = counted.lines;
      file.deletions = 0;
    }
    files.set(path, file);
  }
  const sorted = [...files.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    state: "ok",
    head,
    files: sorted.slice(0, DIFF_LIMITS.files),
    truncated: sorted.length > DIFF_LIMITS.files,
  };
};

/** Cut a patch at the end of its last whole line. */
const wholeLines = (text: string): string => {
  const end = text.lastIndexOf("\n");
  return end === -1 ? "" : text.slice(0, end + 1);
};

/** A whole new file as a patch: every line added. */
const added = (path: string, text: string): string => {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (text === "") return "";
  return [
    `diff --git a/${path} b/${path}`,
    "new file",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
};

/** One file's patch against the same base as the status: a file not tracked is all added. */
export const workspaceFile = async (
  cwd: string,
  path: string,
  trusts: (repository: string) => boolean,
): Promise<DiffPatch> => {
  segmentsOf(path);
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
  if (fields(untracked.stdout).includes(path)) {
    // Read as the Files tab reads: through the same checks that it is inside the folder.
    const { real } = await confine(cwd, path);
    const handle = await open(real, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, DIFF_LIMITS.patch);
      const bytes = new Uint8Array(length);
      await handle.read(bytes, 0, length, 0);
      if (!looksLikeText(bytes.subarray(0, 8 * 1024)))
        return { path, patch: "", truncated: false, binary: true };
      const text = new TextDecoder().decode(bytes);
      const truncated = size > DIFF_LIMITS.patch;
      return {
        path,
        patch: added(path, truncated ? wholeLines(text) : text),
        truncated,
        binary: false,
      };
    } finally {
      await handle.close();
    }
  }
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
