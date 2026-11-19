import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_PERMISSION_MODES,
  CLAUDE_PROMPT_CAPABILITIES,
  DEFAULT_PERMISSION_MODE,
} from "@cycle/adapter-claude";
import { type AgentDefinition, processAgent } from "@cycle/daemon";
import type { Config } from "./config.ts";
import { claudeExecutable, selfCommand } from "./self.ts";

export const CLAUDE_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      title: "Permission mode",
      oneOf: CLAUDE_PERMISSION_MODES.map((m) => ({
        const: m.value,
        title: m.name,
        description: m.description,
        ...("_meta" in m ? { _meta: m._meta } : {}),
      })),
      default: DEFAULT_PERMISSION_MODE,
    },
    model: {
      type: "string",
      title: "Model",
      enum: ["default", "sonnet", "opus", "haiku"],
      default: "default",
    },
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
  // Without this the SDK gives Claude no task list, so there would be no plan to show (config.json can override).
  env.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1";
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
    promptCapabilities: CLAUDE_PROMPT_CAPABILITIES,
    // In the executable, the Claude binary shipped beside it must be there: say so now, not on the first prompt.
    available: () => claudeExecutable() === undefined || existsSync(claudeExecutable() as string),
    command: [...selfCommand(), "adapter", "claude"],
    env: {
      PATH: inherited.PATH ?? "",
      CYCLE_ADAPTER_CONFIG: JSON.stringify({
        env: claudeEnv(config.claude, dataDir, inherited),
        warmStart: config.claude.warmStart,
        progressSummaries: config.claude.progressSummaries,
        ...(claudeExecutable() !== undefined ? { claudeExecutable: claudeExecutable() } : {}),
      }),
    },
  }),
];
