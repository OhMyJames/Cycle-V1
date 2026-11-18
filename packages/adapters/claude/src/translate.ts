import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionUpdate } from "@cycle/acp";

/** What a Claude turn ended with, as ACP's idle `state_update` names it. */
export type StopReason =
  | { stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" }
  | { stopReason: "error"; error: { code: number; message: string } };

export type ToolKind = "read" | "edit" | "search" | "execute" | "fetch" | "think" | "other";

export const toolKind = (name: string): ToolKind => {
  switch (name) {
    case "Read":
      return "read";
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Grep":
    case "Glob":
      return "search";
    case "Bash":
      return "execute";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    case "TodoWrite":
      return "think";
    default:
      return "other";
  }
};

type Block = { type?: string; [key: string]: unknown };

const asText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("");
  }
  return content === undefined ? "" : JSON.stringify(content);
};

/**
 * Turns the Agent SDK's messages for one turn into ACP `session/update` payloads. It holds what it
 * has to remember between messages and nothing else, so it can be tested without a process.
 *
 * Text and thinking arrive twice: as stream events while the model writes, and whole in the
 * `assistant` message after. The stream events are sent; the whole message is sent only for a
 * message that was never streamed.
 */
export class TurnTranslator {
  #messageId: string | undefined;
  #blockTypes = new Map<number, string>();
  readonly #streamed = new Set<string>();

  feed(message: SDKMessage): SessionUpdate[] {
    switch (message.type) {
      case "stream_event":
        return this.#stream(message.event as unknown as { type: string; [key: string]: unknown });
      case "assistant":
        return this.#assistant(message.message as unknown as { id: string; content: Block[] });
      case "user":
        return this.#toolResults(message.message as unknown as { content: unknown });
      default:
        return [];
    }
  }

  #stream(event: { type: string; [key: string]: unknown }): SessionUpdate[] {
    if (event.type === "message_start") {
      const id = (event.message as { id?: string } | undefined)?.id;
      this.#messageId = id;
      if (id !== undefined) this.#streamed.add(id);
      this.#blockTypes.clear();
      return [];
    }
    const index = typeof event.index === "number" ? event.index : -1;
    if (event.type === "content_block_start") {
      const block = event.content_block as Block;
      this.#blockTypes.set(index, String(block.type));
      if (block.type === "tool_use") {
        const name = String(block.name);
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: String(block.id),
            name,
            kind: toolKind(name),
            status: "pending",
          } as SessionUpdate,
        ];
      }
      return [];
    }
    if (event.type === "content_block_delta" && this.#messageId !== undefined) {
      const delta = event.delta as Block;
      if (delta.type === "text_delta") {
        return [chunk("agent_message_chunk", this.#messageId, String(delta.text))];
      }
      if (delta.type === "thinking_delta") {
        return [chunk("agent_thought_chunk", this.#messageId, String(delta.thinking))];
      }
    }
    return [];
  }

  #assistant(message: { id: string; content: Block[] }): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    const streamed = this.#streamed.has(message.id);
    for (const block of message.content) {
      if (block.type === "tool_use") {
        const name = String(block.name);
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: String(block.id),
          name,
          kind: toolKind(name),
          status: "in_progress",
          rawInput: block.input,
        } as SessionUpdate);
      } else if (!streamed && block.type === "text") {
        updates.push({
          sessionUpdate: "agent_message",
          messageId: message.id,
          content: [{ type: "text", text: String(block.text) }],
        } as SessionUpdate);
      }
    }
    return updates;
  }

  #toolResults(message: { content: unknown }): SessionUpdate[] {
    if (!Array.isArray(message.content)) return [];
    const updates: SessionUpdate[] = [];
    for (const block of message.content as Block[]) {
      if (block.type !== "tool_result") continue;
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: String(block.tool_use_id),
        status: block.is_error === true ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: asText(block.content) } }],
        rawOutput: block.content,
      } as SessionUpdate);
    }
    return updates;
  }
}

const chunk = (
  kind: "agent_message_chunk" | "agent_thought_chunk",
  messageId: string,
  text: string,
): SessionUpdate =>
  ({ sessionUpdate: kind, messageId, content: { type: "text", text } }) as SessionUpdate;

/** How a Claude `result` message ends the turn. `cancelled` is the adapter's to say, not the SDK's. */
export const stopReasonOf = (result: SDKMessage): StopReason => {
  if (result.type !== "result") {
    return {
      stopReason: "error",
      error: { code: -32603, message: "The turn ended without a result" },
    };
  }
  if (result.subtype === "success") {
    const reason = (result as { stop_reason?: string | null }).stop_reason;
    if (reason === "max_tokens") return { stopReason: "max_tokens" };
    if (reason === "refusal") return { stopReason: "refusal" };
    return { stopReason: "end_turn" };
  }
  if (result.subtype === "error_max_turns") return { stopReason: "max_turn_requests" };
  return {
    stopReason: "error",
    error: { code: -32603, message: `The turn failed: ${result.subtype}` },
  };
};
