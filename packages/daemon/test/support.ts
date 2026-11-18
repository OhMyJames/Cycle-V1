import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh directory under the system's temporary one, removed when `dispose` runs. */
export const tempDir = async (): Promise<{ dir: string; dispose: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-v1-test-"));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
};
