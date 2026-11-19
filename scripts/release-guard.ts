// Run by the release workflow for a tag, before anything is built, signed or published: the commit being
// released has to be one that is on main. A tag on a branch that never merged (or on a commit someone
// pushed on the side) has a version that can match and is still not a release of main.
//
//   bun scripts/release-guard.ts [ref] [--main origin/main] [--repo dir]
//
// Passes when `ref` (default HEAD) is main or an ancestor of it: the current main, and an older commit of it
// (a release made later for a past version) both qualify. Needs the history of main, not a shallow clone.
// Exit 0: on main. 1: not on main, or main cannot be checked (the message says which).
//
//   bun scripts/release-guard.ts --step v0.3.1 [--repo dir]
//
// The owner's rule (2026-11-19): a release only moves the third number. The tag must keep the major and
// minor of the newest release tag and have a higher patch; `0.3.0` → `0.3.1` passes, `0.3.0` → `0.4.0`
// does not. Changing the first two numbers is the owner's decision, made by hand, not by a release.

import { spawnSync } from "node:child_process";

export type Verdict = { ok: true; commit: string } | { ok: false; why: string };

const git = (repo: string, args: string[]) => {
  // GIT_DIR and the like (set when this runs from a git hook) would point git somewhere else than `repo`.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
};

export const onMain = (repo: string, ref = "HEAD", main = "origin/main"): Verdict => {
  const shallow = git(repo, ["rev-parse", "--is-shallow-repository"]);
  if (shallow.out === "true")
    return {
      ok: false,
      why: "this is a shallow clone: the history of main is not here, so whether the commit is on it cannot be known (check out with fetch-depth: 0)",
    };
  const commit = git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (commit.code !== 0) return { ok: false, why: `${ref} is not a commit here` };
  if (git(repo, ["rev-parse", "--verify", "--quiet", `${main}^{commit}`]).code !== 0)
    return { ok: false, why: `${main} is not here: main cannot be checked` };
  const ancestor = git(repo, ["merge-base", "--is-ancestor", commit.out, main]);
  if (ancestor.code === 0) return { ok: true, commit: commit.out };
  if (ancestor.code === 1)
    return {
      ok: false,
      why: `${commit.out} is not on ${main}: a release is made from a commit that has been merged into main`,
    };
  return { ok: false, why: `could not compare with ${main}: ${ancestor.err}` };
};

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Whether `next` is a patch step past the newest of `tags` (other than itself). */
export const patchStep = (next: string, tags: readonly string[]): Verdict => {
  const parse = (tag: string) => {
    const m = tag.match(SEMVER);
    return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const wanted = parse(next);
  if (wanted === undefined) return { ok: false, why: `${next} is not a version of three numbers` };
  const released = tags
    .filter((tag) => tag.replace(/^v/, "") !== next.replace(/^v/, ""))
    .map(parse)
    .filter((v): v is number[] => v !== undefined)
    .sort(
      (a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0),
    );
  const newest = released.at(-1);
  if (newest === undefined) return { ok: true, commit: next };
  const [major, minor, patch] = wanted;
  if (major !== newest[0] || minor !== newest[1])
    return {
      ok: false,
      why: `${next} changes the first two numbers of ${newest.join(".")}: a release only moves the third`,
    };
  if ((patch ?? 0) <= (newest[2] ?? 0))
    return { ok: false, why: `${next} is not past ${newest.join(".")}` };
  return { ok: true, commit: next };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string): string => {
    const at = args.indexOf(name);
    if (at === -1) return fallback;
    const [, value] = args.splice(at, 2);
    return value ?? fallback;
  };
  const main = option("--main", "origin/main");
  const repo = option("--repo", ".");
  const step = option("--step", "");
  if (step !== "") {
    const verdict = patchStep(step, git(repo, ["tag", "--list", "v*"]).out.split("\n"));
    if (!verdict.ok) {
      console.error(`release refused: ${verdict.why}`);
      process.exit(1);
    }
    console.log(`${step} moves only the third number`);
    process.exit(0);
  }
  const verdict = onMain(repo, args[0] ?? "HEAD", main);
  if (!verdict.ok) {
    console.error(`release refused: ${verdict.why}`);
    process.exit(1);
  }
  console.log(`${verdict.commit} is on ${main}`);
}
