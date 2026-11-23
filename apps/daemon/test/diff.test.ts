import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DIFF_LIMITS } from "@cycle/protocol";
import { workspaceFile, workspaceStatus } from "../src/diff.ts";
import { gitIn, tempDir } from "./support.ts";

let work: string;
let outside: string;
let disposeWork: () => Promise<void>;
let disposeOutside: () => Promise<void>;
beforeEach(async () => {
  ({ dir: work, dispose: disposeWork } = await tempDir());
  ({ dir: outside, dispose: disposeOutside } = await tempDir());
  work = await realpath(work);
});
afterEach(async () => {
  await disposeWork();
  await disposeOutside();
});

const trusted = () => true;

const commitAll = () => {
  gitIn(work, "add", "-A");
  gitIn(work, "commit", "-q", "-m", "base");
};

test("a folder in no repository, or in one not trusted, has no workspace diff and says why", async () => {
  expect(await workspaceStatus(work, trusted)).toEqual({ state: "not_git" });
  gitIn(work, "init", "-q");
  expect(await workspaceStatus(work, () => false)).toEqual({
    state: "untrusted",
    repository: work,
  });
  await expect(workspaceFile(work, "a.txt", () => false)).rejects.toMatchObject({
    code: -32602,
    data: expect.objectContaining({ reason: "untrusted" }),
  });
});

test("before the first commit everything is compared with nothing", async () => {
  gitIn(work, "init", "-q");
  await writeFile(join(work, "staged.txt"), "a\nb\n");
  gitIn(work, "add", "staged.txt");
  await writeFile(join(work, "new.txt"), "x");
  expect(await workspaceStatus(work, trusted)).toEqual({
    state: "ok",
    head: null,
    truncated: false,
    files: [
      { path: "new.txt", status: "untracked", additions: 1, deletions: 0 },
      { path: "staged.txt", status: "added", additions: 2, deletions: 0 },
    ],
  });
});

test("the working tree against HEAD: changed, deleted, staged, untracked and binary, ignored left out", async () => {
  gitIn(work, "init", "-q");
  await writeFile(join(work, ".gitignore"), "*.log\n");
  await writeFile(join(work, "keep.txt"), "one\ntwo\nthree\n");
  await writeFile(join(work, "gone.txt"), "bye\n");
  await writeFile(join(work, "pic.bin"), new Uint8Array([0, 1, 2]));
  commitAll();
  await writeFile(join(work, "keep.txt"), "one\n2\nthree\nfour\n");
  await Bun.file(join(work, "gone.txt")).delete();
  await writeFile(join(work, "pic.bin"), new Uint8Array([0, 1, 3]));
  await writeFile(join(work, "fresh.ts"), "let a;\nlet b;\n");
  await writeFile(join(work, "noise.log"), "ignored");
  const status = await workspaceStatus(work, trusted);
  expect(status).toMatchObject({ state: "ok", head: expect.stringMatching(/^[0-9a-f]{40}$/) });
  expect(status.state === "ok" ? status.files : []).toEqual([
    { path: "fresh.ts", status: "untracked", additions: 2, deletions: 0 },
    { path: "gone.txt", status: "deleted", additions: 0, deletions: 1 },
    { path: "keep.txt", status: "modified", additions: 2, deletions: 1 },
    { path: "pic.bin", status: "modified", binary: true },
  ]);

  const keep = await workspaceFile(work, "keep.txt", trusted);
  expect(keep).toMatchObject({ path: "keep.txt", truncated: false, binary: false });
  expect(keep.patch).toContain("@@ -1,3 +1,4 @@");
  expect(keep.patch).toContain("-two\n+2\n");
  const fresh = await workspaceFile(work, "fresh.ts", trusted);
  expect(fresh.patch).toContain("@@ -0,0 +1,2 @@\n+let a;\n+let b;\n");
  expect(await workspaceFile(work, "pic.bin", trusted)).toEqual({
    path: "pic.bin",
    patch: "",
    truncated: false,
    binary: true,
  });
  // Unchanged: nothing to show.
  expect((await workspaceFile(work, ".gitignore", trusted)).patch).toBe("");
  await expect(workspaceFile(work, "../x", trusted)).rejects.toMatchObject({ code: -32602 });
});

test("only what is inside the session's folder, by paths relative to it, and its trust taken at the repository", async () => {
  gitIn(work, "init", "-q");
  await mkdir(join(work, "app"));
  await writeFile(join(work, "app", "a.ts"), "1\n");
  await writeFile(join(work, "root.ts"), "1\n");
  commitAll();
  await writeFile(join(work, "app", "a.ts"), "2\n");
  await writeFile(join(work, "root.ts"), "2\n");
  const asked: string[] = [];
  const status = await workspaceStatus(join(work, "app"), (repository) => {
    asked.push(repository);
    return true;
  });
  expect(asked).toEqual([work]);
  expect(status.state === "ok" ? status.files.map((f) => f.path) : []).toEqual(["a.ts"]);
  expect((await workspaceFile(join(work, "app"), "a.ts", trusted)).patch).toContain("+2");
});

test("an untracked link out of the folder is not read, and a large patch is cut at a line's end", async () => {
  gitIn(work, "init", "-q");
  await writeFile(join(outside, "secret"), "s\n");
  await symlink(join(outside, "secret"), join(work, "peek"));
  await writeFile(join(work, "big.txt"), "");
  commitAll();
  const status = await workspaceStatus(work, trusted);
  // Git tracks the link itself; its target is never read.
  expect(JSON.stringify(status)).not.toContain("secret");
  await writeFile(join(work, "big.txt"), `${"line of text\n".repeat(DIFF_LIMITS.patch / 10)}`);
  const big = await workspaceFile(work, "big.txt", trusted);
  expect(big.truncated).toBe(true);
  expect(big.patch.length).toBeLessThanOrEqual(DIFF_LIMITS.patch);
  expect(big.patch.endsWith("\n")).toBe(true);
  await symlink(join(outside, "secret"), join(work, "peek2"));
  await expect(workspaceFile(work, "peek2", trusted)).rejects.toMatchObject({
    code: -32602,
    data: expect.objectContaining({ reason: "outside" }),
  });
});
