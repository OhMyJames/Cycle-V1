import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** What `fakeQuery` was called with, so a test can see the options the adapter chose. */
export type Call = { prompt: string; options: Options };

const delta = (index: number, text: string) =>
  ({
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  }) as unknown as SDKMessage;

/** The messages of a turn in which Claude answers with `text`, as the SDK sends them. */
export const textTurn = (sessionId: string, messageId: string, text: string): SDKMessage[] =>
  [
    { type: "system", subtype: "init", session_id: sessionId },
    { type: "stream_event", event: { type: "message_start", message: { id: messageId } } },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    delta(0, text.slice(0, 3)),
    delta(0, text.slice(3)),
    {
      type: "assistant",
      message: { id: messageId, content: [{ type: "text", text }] },
    },
    { type: "result", subtype: "success", stop_reason: "end_turn", session_id: sessionId },
  ] as unknown as SDKMessage[];

/** A stand-in for the SDK's `query` that plays back messages and records its calls. */
export const fakeQuery = (turns: (call: Call) => SDKMessage[] | Promise<SDKMessage[]>) => {
  const calls: Call[] = [];
  const run = (call: Call): Query => {
    calls.push(call);
    let interrupted = false;
    const iterator = (async function* () {
      for (const message of await turns(call)) {
        if (interrupted) return;
        yield message;
      }
    })();
    return Object.assign(iterator, {
      interrupt: async () => {
        interrupted = true;
        return undefined;
      },
    }) as unknown as Query;
  };
  return { calls, run };
};
