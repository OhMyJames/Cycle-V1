import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onMain, patchStep } from "./release-guard.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cycle-v1-guard-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A git hook runs with GIT_DIR and friends set: what the test runs must not see them. */
const clean = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !k.startsWith("GIT_") && v !== undefined),
  ) as Record<string, string>;

const git = (cwd: string, ...args: string[]): string => {
  const run = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: clean() },
  );
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.toString().trim();
};

/** An "origin" with main (c1, c2) and a branch that never merged (c1, side), cloned the way CI does. */
const fixture = async (depth?: number) => {
  const origin = join(dir, "origin");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", origin], { env: clean() });
  git(origin, "commit", "-q", "--allow-empty", "-m", "c1");
  const c1 = git(origin, "rev-parse", "HEAD");
  git(origin, "commit", "-q", "--allow-empty", "-m", "c2");
  const c2 = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "-b", "side", c1);
  git(origin, "commit", "-q", "--allow-empty", "-m", "side");
  const side = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "main");
  const clone = join(dir, "clone");
  git(dir, "clone", "-q", ...(depth ? ["--depth", String(depth)] : []), `file://${origin}`, clone);
  git(clone, "fetch", "-q", "origin", "side");
  return { clone, c1, c2, side };
};

test("the current main and an older commit of main are on main", async () => {
  const { clone, c1, c2 } = await fixture();
  expect(onMain(clone, c2)).toEqual({ ok: true, commit: c2 });
  expect(onMain(clone, c1)).toEqual({ ok: true, commit: c1 });
  expect(onMain(clone, "origin/main")).toEqual({ ok: true, commit: c2 });
});

test("a commit that was never merged into main is refused, with its sha in the message", async () => {
  const { clone, side } = await fixture();
  const verdict = onMain(clone, side);
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) expect(verdict.why).toContain(side);
});

test("an annotated tag is judged by the commit it points to", async () => {
  const { clone, c1, side } = await fixture();
  git(clone, "tag", "-a", "-m", "m", "v-main", c1);
  git(clone, "tag", "-a", "-m", "m", "v-side", side);
  expect(onMain(clone, "v-main").ok).toBe(true);
  expect(onMain(clone, "v-side").ok).toBe(false);
});

test("a shallow clone is refused: main's history is not there to look in", async () => {
  const { clone, c2 } = await fixture(1);
  const verdict = onMain(clone, c2);
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) expect(verdict.why).toContain("shallow");
});

test("no main to compare with, and a ref that is not a commit, are refused", async () => {
  const { clone, c2 } = await fixture();
  const none = onMain(clone, c2, "origin/nope");
  expect(none.ok).toBe(false);
  if (!none.ok) expect(none.why).toContain("origin/nope");
  expect(onMain(clone, "v9.9.9").ok).toBe(false);
});

test("the command exits 1 for the branch commit and 0 for main", async () => {
  const { clone, c2, side } = await fixture();
  const run = (ref: string) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "release-guard.ts"), ref, "--repo", clone], {
      env: clean(),
    });
  expect(run(c2).exitCode).toBe(0);
  const refused = run(side);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("release refused");
});

test("the release workflow asks the guard of a tag, with the whole history, before anything is installed or built", async () => {
  const workflow = await Bun.file(
    join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
  ).text();
  const check = workflow.slice(
    workflow.indexOf("\n  check:"),
    workflow.indexOf("\n  daemon-linux:"),
  );
  expect(check).toContain("fetch-depth: 0");
  const guard = check.indexOf("scripts/release-guard.ts");
  expect(guard).toBeGreaterThan(-1);
  expect(check.slice(check.lastIndexOf("- name:", guard), guard)).toContain(
    "github.ref_type == 'tag'",
  );
  expect(guard).toBeLessThan(check.indexOf("bun install"));
  // What publishes waits for it.
  expect(workflow.match(/needs: check/g)?.length).toBe(2);
});

test("a release only moves the third number of the newest release", () => {
  const tags = ["v0.2.9", "v0.3.0", "v0.2.10"];
  expect(patchStep("v0.3.1", tags).ok).toBe(true);
  expect(patchStep("v0.3.12", tags).ok).toBe(true);
  expect(patchStep("v0.4.0", tags)).toMatchObject({ ok: false });
  expect(patchStep("v1.0.0", tags)).toMatchObject({ ok: false });
  expect(patchStep("v0.3.0", ["v0.3.0", "v0.3.1"])).toMatchObject({ ok: false });
  expect(patchStep("v0.3", tags)).toMatchObject({ ok: false });
  // The tag being released is not its own predecessor.
  expect(patchStep("v0.3.1", [...tags, "v0.3.1"]).ok).toBe(true);
});
