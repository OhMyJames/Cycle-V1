import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the daemon keeps its data. `~/.cycle` is not used: another project keeps live data there.
 * Everything that opens files takes the directory as an argument, and tests pass a temporary one, so
 * no test can reach a real home.
 */
export const DATA_DIR_ENV = "CYCLE_V1_HOME";

export const defaultDataDir = (env: Record<string, string | undefined> = process.env): string =>
  env[DATA_DIR_ENV] ?? join(homedir(), ".cycle-v1");

export const sessionsDir = (dataDir: string): string => join(dataDir, "sessions");
export const indexPath = (dataDir: string): string => join(dataDir, "index.json");
export const defaultsPath = (dataDir: string): string => join(dataDir, "agent-defaults.json");
