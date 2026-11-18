// The adapter's entry point: an ACP v2 agent on stdin and stdout.
// Everything it needs comes in as CYCLE_ADAPTER_CONFIG (JSON), never from this process's own
// environment. See AdapterConfig.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ndJsonStream } from "@cycle/acp";
import { type AdapterConfig, createAgent } from "./agent.ts";

const raw = process.env.CYCLE_ADAPTER_CONFIG;
if (raw === undefined) {
  console.error("CYCLE_ADAPTER_CONFIG is not set");
  process.exit(2);
}
const config = JSON.parse(raw) as AdapterConfig;

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
