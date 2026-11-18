/**
 * A stand-in for the Anthropic API on a local port, so a run needs no account and no network.
 * It answers `POST /v1/messages` with a streamed reply, and records every request it gets.
 */

export type MockRequest = { method: string; path: string; body: unknown };

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const textReply = (text: string, id = "msg_mock"): string =>
  [
    sse("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "mock-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");

/** A reply in which Claude asks to run a tool. */
export const toolReply = (
  name: string,
  input: unknown,
  id = "msg_tool",
  toolId = "toolu_mock1",
): string =>
  [
    sse("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "mock-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: toolId, name, input: {} },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");

/** The text of every message the model was sent, flattened, to see what context it had. */
export const sentText = (body: unknown): string =>
  JSON.stringify((body as { messages?: unknown }).messages ?? []);

export const startMock = (
  reply: (requests: MockRequest[]) => string = () => textReply("Hello from the mock."),
) => {
  const requests: MockRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      requests.push({ method: request.method, path: url.pathname, body });
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return new Response(reply(requests), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(
        JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock" } }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
};
