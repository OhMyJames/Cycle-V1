import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs git in `dir` as a test sets a repository up: none of the person's own configuration, hooks or identity (HOME is
 * the folder itself, and the system's configuration is not read). Throws when git fails.
 */
export const gitIn = (dir: string, ...args: string[]): string => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
};

/** A fresh directory under the system's temporary one, removed when `dispose` runs. */
export const tempDir = async (): Promise<{ dir: string; dispose: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-v1-test-"));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
};
