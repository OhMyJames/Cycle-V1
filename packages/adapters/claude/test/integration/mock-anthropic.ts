/**
 * A stand-in for the Anthropic API on a local port, so a run needs no account and no network.
 * It answers `POST /v1/messages` with a streamed reply, and records every request it gets.
 */

export type MockReply = string | ReadableStream<Uint8Array>;

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

/**
 * A streamed text reply that stops after `first` and sends `rest` only once `release` is called, so a
 * test can act while the model is still writing. If the client has gone by then, the rest is dropped.
 */
export const heldTextReply = (first: string, rest: string) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const [head, ...tail] = textReply(first + rest).split("event: content_block_delta");
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(head ?? ""));
        controller.enqueue(
          encoder.encode(
            sse("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: first },
            }),
          ),
        );
        await gate;
        controller.enqueue(
          encoder.encode(
            sse("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: rest },
            }),
          ),
        );
        // What followed the delta in the full reply.
        const after = tail.join("event: content_block_delta").split("\n\n").slice(1).join("\n\n");
        controller.enqueue(encoder.encode(after));
        controller.close();
      } catch {
        // The client hung up.
      }
    },
  });
  return { body, release };
};

export const startMock = (
  reply: (requests: MockRequest[]) => MockReply = () => textReply("Hello from the mock."),
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
