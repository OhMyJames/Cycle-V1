// Git, as the daemon runs it to look at a session's folder: only for a repository the person trusts, since a repository's
// own configuration can make git run commands (.agents/notes/2026-11-22-files-and-diff-sources.md), and even then with
// what can be turned off turned off, an environment it is given rather than the daemon's, and a time limit.
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** What git may run for: a listing waits on it. */
const TIME_LIMIT_MS = 5_000;

const HARDENED = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
];

/** The environment git is given: enough to find itself and the person's own ignore rules, nothing of the daemon's. */
export const gitEnv = (inherited: Record<string, string | undefined> = process.env) => {
  const env: Record<string, string> = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  for (const name of ["PATH", "HOME"] as const) {
    const value = inherited[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

export type GitResult = {
  code: number;
  stdout: Uint8Array;
  /** Git said more than `maxBytes`: what it said is cut there, and it was stopped. */
  cut: boolean;
};

export type GitOptions = {
  /** On its standard input. */
  input?: string;
  /** Paths are paths, never pathspec magic. */
  literal?: boolean;
  timeoutMs?: number;
  /** Past this many bytes of output git is stopped and the output cut. */
  maxBytes?: number;
};

/** Up to `max` bytes of a stream, and whether there were more. */
const readUpTo = async (
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<{ bytes: Uint8Array; cut: boolean }> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return { bytes: Buffer.concat(chunks).subarray(0, max), cut: true };
    }
  }
  return { bytes: Buffer.concat(chunks), cut: false };
};

/**
 * Runs git in `dir` with `args`, looking for a repository no higher than `top`. Undefined when git is not there or took
 * too long.
 */
export const runGit = async (
  dir: string,
  top: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult | undefined> => {
  let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    child = Bun.spawn(["git", "-C", dir, ...HARDENED, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...gitEnv(),
        // The repository found is the one whose trust was asked about, not one further up.
        GIT_CEILING_DIRECTORIES: dirname(top),
        ...(options.literal === true ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
      },
    });
  } catch {
    return undefined;
  }
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? TIME_LIMIT_MS);
  try {
    // Read while writing: git answers as it goes, and a full pipe on either side would stop both.
    const output = readUpTo(child.stdout, options.maxBytes ?? Number.POSITIVE_INFINITY);
    if (options.input !== undefined) child.stdin.write(options.input);
    await child.stdin.end();
    const { bytes, cut } = await output;
    if (cut) child.kill();
    const code = await child.exited;
    if (!cut && child.signalCode !== null) return undefined;
    return { code, stdout: bytes, cut };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/** The top of the repository a real folder is in, as git would find it (the nearest `.git` up), or undefined. */
export const repositoryOf = async (dir: string): Promise<string | undefined> => {
  for (let at = dir; ; at = dirname(at)) {
    if (
      await lstat(join(at, ".git")).then(
        () => true,
        () => false,
      )
    )
      return at;
    if (dirname(at) === at) return undefined;
  }
};

/**
 * Which of `names`, all in the real folder `dir`, git ignores; only when the repository `dir` is in is trusted, since
 * its configuration is what git reads. Empty when there is no repository, it is not trusted, or git cannot say: an
 * entry not marked is not known to be ignored, nothing more.
 */
export const ignoredNames = async (
  dir: string,
  names: readonly string[],
  trusts: (repository: string) => boolean,
): Promise<Set<string>> => {
  if (names.length === 0) return new Set();
  const repository = await repositoryOf(dir);
  if (repository === undefined || !trusts(repository)) return new Set();
  // NUL-separated both ways: a name may hold a newline. `./` first, so that a name starting with `:` is a name and not
  // pathspec magic (check-ignore takes no literal pathspecs); git answers with the same `./`.
  const input = names.map((name) => `./${name}\0`).join("");
  const result = await runGit(dir, repository, ["check-ignore", "-z", "--stdin"], { input });
  // 0: some are ignored; 1: none are; anything else (128: not a repository) says nothing.
  if (result === undefined || result.code !== 0) return new Set();
  return new Set(
    new TextDecoder()
      .decode(result.stdout)
      .split("\0")
      .filter((name) => name !== "")
      .map((name) => (name.startsWith("./") ? name.slice(2) : name)),
  );
};
