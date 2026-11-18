// Run by the release workflow for a tag, before anything is built, signed or published: the commit being
// released has to be one that is on main. A tag on a branch that never merged (or on a commit someone
// pushed on the side) has a version that can match and is still not a release of main.
//
//   bun scripts/release-guard.ts [ref] [--main origin/main] [--repo dir]
//
// Passes when `ref` (default HEAD) is main or an ancestor of it: the current main, and an older commit of it
// (a release made later for a past version) both qualify. Needs the history of main, not a shallow clone.
// Exit 0: on main. 1: not on main, or main cannot be checked (the message says which).

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
  const verdict = onMain(repo, args[0] ?? "HEAD", main);
  if (!verdict.ok) {
    console.error(`release refused: ${verdict.why}`);
    process.exit(1);
  }
  console.log(`${verdict.commit} is on ${main}`);
}
