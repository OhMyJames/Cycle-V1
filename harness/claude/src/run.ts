// Runs the adapter on this process's stdin and stdout. Everything it needs comes in as
// CYCLE_ADAPTER_CONFIG (JSON), never from this process's own environment. See AdapterConfig.

import { ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { type AdapterConfig, createAgent } from "./agent.ts";

export const runAdapter = async (): Promise<void> => {
  const raw = process.env.CYCLE_ADAPTER_CONFIG;
  if (raw === undefined) {
    console.error("CYCLE_ADAPTER_CONFIG is not set");
    process.exit(2);
  }
  const config = JSON.parse(raw) as AdapterConfig;

  // The SDK reads a session's record from the Claude config directory named in this process's own
  // environment. That is the one Claude was given, and never anything else: with none, no titles.
  const configDir = config.env.CLAUDE_CONFIG_DIR;
  if (configDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = configDir;
    config.sessionInfo = (sessionId, cwd) => getSessionInfo(sessionId, { dir: cwd });
  }

  const stream = ndJsonStream(
    new WritableStream({
      write: (chunk) => {
        process.stdout.write(chunk);
      },
    }),
    new ReadableStream({
      start(controller) {
        process.stdin.on("data", (chunk) =>
          controller.enqueue(
            typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
          ),
        );
        process.stdin.on("end", () => controller.close());
      },
    }),
  );

  const connection = createAgent(config, query).connect(stream);
  await connection.closed;
};
