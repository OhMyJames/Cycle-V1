import { join } from "node:path";
import { type AgentDefinition, processAgent } from "@cycle/daemon";
import type { Config } from "./config.ts";

const ADAPTER = new URL("../../../packages/adapters/claude/src/main.ts", import.meta.url).pathname;

export const CLAUDE_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      title: "Permission mode",
      enum: ["default", "acceptEdits", "plan"],
      default: "default",
    },
    model: { type: "string", title: "Model" },
  },
} as const;

/** What the Claude process is allowed to see, and nothing else. */
export const claudeEnv = (
  config: Config["claude"],
  dataDir: string,
  inherited: Record<string, string | undefined>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of config.allowEnv) {
    const value = inherited[name];
    if (value !== undefined) env[name] = value;
  }
  env.CLAUDE_CONFIG_DIR = config.configDir ?? join(dataDir, "claude");
  // HOME is not passed on: it would let Claude find a login or settings nobody chose to share.
  env.HOME ??= env.CLAUDE_CONFIG_DIR;
  return { ...env, ...config.env };
};

export const agentsFor = (
  config: Config,
  dataDir: string,
  inherited: Record<string, string | undefined> = process.env,
): AgentDefinition[] => [
  processAgent({
    id: "claude",
    name: "Claude",
    configSchema: CLAUDE_CONFIG_SCHEMA,
    command: ["bun", ADAPTER],
    env: {
      PATH: inherited.PATH ?? "",
      CYCLE_ADAPTER_CONFIG: JSON.stringify({ env: claudeEnv(config.claude, dataDir, inherited) }),
    },
  }),
];
