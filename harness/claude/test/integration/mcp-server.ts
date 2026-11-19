// A stand-in MCP server over stdio, for a test: it has one tool, and the tool's name says what its
// TOKEN environment variable was, so a test can tell that the server's env reached it.
import { createInterface } from "node:readline";

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { id?: number; method: string };
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "files", version: "0" },
      },
    });
  } else if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "MCP-OK-7731" }] },
    });
  } else if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: `token_${process.env.TOKEN ?? "none"}`,
            description: "Reports the token this server was started with, in its own name.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
  }
}
