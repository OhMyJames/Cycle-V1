import { join } from "node:path";
import { defaultDataDir } from "@cycle/daemon";
import { z } from "zod";

/**
 * `<dataDir>/config.json`. Everything an agent may see is written here or named here: the daemon
 * hands an agent nothing it was not told to (AGENTS.md), because its own environment holds keys that
 * override a user's login and bill an API.
 */
export const ConfigSchema = z.object({
  claude: z
    .object({
      /**
       * Claude's own config directory: its login and its transcripts. Default `<dataDir>/claude`, a
       * directory of its own. To use an existing login, point this at it (`~/.claude`) on purpose.
       */
      configDir: z.string().optional(),
      /** Names of the daemon's own variables the Claude process may see. */
      allowEnv: z.array(z.string()).default(["PATH", "LANG", "LC_ALL", "TERM"]),
      /** Variables set to a value, e.g. a key or a base URL. Written here, never inherited. */
      env: z.record(z.string(), z.string()).default({}),
      /**
       * Start a session's Claude process when the session is made, so its slash commands are known
       * before the first message (decision 0014). Costs about 230 MB per new session until it is idle.
       */
      warmStart: z.boolean().default(true),
      /** Ask Claude for a model-written progress line for each sub-agent: a model call each. */
      progressSummaries: z.boolean().default(true),
    })
    .default({
      allowEnv: ["PATH", "LANG", "LC_ALL", "TERM"],
      env: {},
      warmStart: true,
      progressSummaries: true,
    }),
});
export type Config = z.infer<typeof ConfigSchema>;

export type Paths = { dataDir: string; socket: string; config: string };

export const pathsFor = (dataDir: string, socket?: string): Paths => ({
  dataDir,
  socket: socket ?? join(dataDir, "daemon.sock"),
  config: join(dataDir, "config.json"),
});

export const loadConfig = async (path: string): Promise<Config> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return ConfigSchema.parse({});
  try {
    return ConfigSchema.parse(JSON.parse(await file.text()));
  } catch (error) {
    throw new Error(`${path} cannot be read: ${error instanceof Error ? error.message : error}`);
  }
};

export { defaultDataDir };
