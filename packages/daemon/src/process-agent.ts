import { ndJsonStream } from "@cycle/acp";
import type { PromptCapabilities } from "@cycle/protocol";
import type { AgentDefinition } from "./agents.ts";

export type ProcessAgentOptions = {
  id: string;
  name: string;
  configSchema?: Record<string, unknown>;
  /** What the agent takes in a prompt beyond text and links; see `AgentDefinition`. */
  promptCapabilities?: PromptCapabilities;
  command: string[];
  /**
   * The child's whole environment. Nothing is inherited from the daemon: the daemon's own variables
   * hold keys that override a user's login and bill an API (AGENTS.md).
   */
  env: Record<string, string>;
  cwd?: string;
  /** Whether it can run at all, checked when clients ask which agents there are. */
  available?: () => boolean | Promise<boolean>;
};

/** An agent that is a child process speaking ACP v2 on its stdin and stdout. */
export const processAgent = (options: ProcessAgentOptions): AgentDefinition => ({
  id: options.id,
  name: options.name,
  configSchema: options.configSchema ?? { type: "object", properties: {} },
  ...(options.promptCapabilities !== undefined
    ? { promptCapabilities: options.promptCapabilities }
    : {}),
  ...(options.available !== undefined ? { available: options.available } : {}),
  launch: async () => {
    const proc = Bun.spawn(options.command, {
      env: options.env,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    const input = new WritableStream<Uint8Array>({
      write: (chunk) => {
        proc.stdin.write(chunk);
        proc.stdin.flush();
      },
      close: () => {
        proc.stdin.end();
      },
    });
    return { target: ndJsonStream(input, proc.stdout), kill: () => proc.kill() };
  },
});
