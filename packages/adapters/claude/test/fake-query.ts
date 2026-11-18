import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** What a turn is asked to do: the text of the user message that began it, and the options of its query. */
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

const textOfInput = (message: SDKUserMessage): string => {
  const content = (message.message as { content: unknown }).content;
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[]).map((b) => b.text ?? "").join("");
};

/**
 * A stand-in for the SDK's `query` in streaming-input mode, like the real one: the process lives as
 * long as the input does, each pushed user message gets one scripted turn, `interrupt` ends the turn
 * that is running with an error result and leaves the process up, and an abort or `kill` ends the
 * stream with an error.
 */
export const fakeQuery = (turns: (call: Call) => SDKMessage[] | Promise<SDKMessage[]>) => {
  /** One entry per query started: the first prompt it was given, and its options. */
  const calls: Call[] = [];
  /** Every user message pushed, in order. */
  const prompts: string[] = [];
  /** The same, as the SDK was given them: a string, or content blocks. */
  const contents: unknown[] = [];
  const state = {
    /** What `supportedCommands()` answers. */
    commands: [] as { name: string; description: string; argumentHint: string }[],
    interrupts: 0,
    /** How long `setPermissionMode` takes, as a process that is busy takes. */
    setterDelayMs: 0,
    permissionModes: [] as string[],
    models: [] as (string | undefined)[],
    /** Make `setPermissionMode` and `setModel` throw, as they do on a process that is gone. */
    failSetters: false,
    /** `interrupt` does nothing, as for a process that has hung. */
    ignoreInterrupt: false,
    /** Makes the newest query's stream end with an error, as if its process had died. */
    kill: (_error?: Error): void => undefined,
    /** True when the newest query's input was closed (the adapter let it go). */
    inputClosed: false,
  };
  const run = (params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options: Options;
  }): Query => {
    const { options } = params;
    const input =
      typeof params.prompt === "string"
        ? (async function* () {
            yield {
              type: "user",
              message: { role: "user", content: params.prompt },
            } as SDKUserMessage;
          })()
        : params.prompt;
    state.inputClosed = false;
    // An interrupt that arrives before the process has picked the message up is not lost.
    let interruptedEarly = false;
    let interrupt: () => void = () => {
      interruptedEarly = true;
    };
    const signal = options.abortController?.signal;
    const ended = new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
      state.kill = (error) => reject(error ?? new Error("the Claude process died"));
    });
    ended.catch(() => undefined);

    const iterator = (async function* () {
      const next = input[Symbol.asyncIterator]();
      for (;;) {
        const pushed = await Promise.race([next.next(), ended]);
        if (pushed.done) {
          state.inputClosed = true;
          return;
        }
        const text = textOfInput(pushed.value);
        prompts.push(text);
        contents.push((pushed.value.message as { content: unknown }).content);
        if (calls.at(-1)?.options !== options) calls.push({ prompt: text, options });
        const interrupted = new Promise<"interrupted">((resolve) => {
          interrupt = () => resolve("interrupted");
          if (interruptedEarly) resolve("interrupted");
          interruptedEarly = false;
        });
        const messages = await Promise.race([
          Promise.resolve().then(() => turns({ prompt: text, options })),
          interrupted,
          ended,
        ]);
        if (messages === "interrupted") {
          yield {
            type: "result",
            subtype: "error_during_execution",
            stop_reason: null,
          } as unknown as SDKMessage;
          continue;
        }
        for (const message of messages) yield message;
      }
    })();
    return Object.assign(iterator, {
      interrupt: async () => {
        state.interrupts++;
        if (!state.ignoreInterrupt) interrupt();
      },
      setPermissionMode: async (mode: string) => {
        if (state.setterDelayMs > 0) await new Promise((r) => setTimeout(r, state.setterDelayMs));
        if (state.failSetters) throw new Error("the process is gone");
        state.permissionModes.push(mode);
      },
      supportedCommands: async () => state.commands,
      setModel: async (model?: string) => {
        if (state.failSetters) throw new Error("the process is gone");
        state.models.push(model);
      },
    }) as unknown as Query;
  };
  return { calls, prompts, contents, run, state };
};
