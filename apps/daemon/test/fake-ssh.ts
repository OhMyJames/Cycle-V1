import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempDir = async () => {
  // Socket paths are short-limited (about 100 bytes): keep the name short.
  const dir = await mkdtemp(join(tmpdir(), "cv1-"));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
};

/**
 * A stand-in for `ssh`: it skips ssh's own options, takes the host, and runs the rest of the
 * command here. So a test goes through the same argv ssh would get, without a server.
 */
export const fakeSsh = async (dir: string): Promise<{ path: string; calls: string }> => {
  const path = join(dir, "fake-ssh");
  const calls = join(dir, "fake-ssh-calls.txt");
  await writeFile(
    path,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + "\\n");
let i = 0;
while (argv[i]?.startsWith("-")) i += argv[i] === "-o" ? 2 : 1;
const host = argv[i];
const command = argv.slice(i + 1);
const proc = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);
`,
  );
  await chmod(path, 0o755);
  return { path, calls };
};
