// A mention of another session in a prompt (docs/protocol.md §8 "提及(@)另一个 session"). The daemon keeps every
// session's history, so it gives the agent a short record of the one mentioned as it hands the prompt over, and puts
// the mention back in the agent's echo, so that the history holds the link and not the record. Why a record and not a
// tool: .agents/notes/2026-11-22-session-mentions-expand-in-the-daemon.md.
import { META, SESSION_MENTION_LIMITS, sessionIdOfUri } from "@cycle/protocol";
import type { LogRecord } from "./log/types.ts";

type Block = Record<string, unknown> & { type?: unknown; _meta?: unknown };

/** One thing said in a session, as the record gives it. */
export type Said = { from: "user" | "agent"; text: string };

/** What the daemon knows of a mentioned session, or why it has nothing to give. */
export type Mentioned =
  | { found: true; title?: string | undefined; records: readonly LogRecord[] }
  | { found: false; why: "missing" | "unreadable" | "self" };

const metaOf = (block: Block): Record<string, unknown> | undefined =>
  typeof block._meta === "object" && block._meta !== null
    ? (block._meta as Record<string, unknown>)
    : undefined;

/** The session a block of a prompt mentions, if it is a mention of a session. */
export const mentionedSession = (block: unknown): string | undefined => {
  const b = block as Block | null;
  return b !== null && typeof b === "object" && b.type === "resource_link"
    ? sessionIdOfUri(b.uri)
    : undefined;
};

/** Whether a prompt mentions any session: most do not, and are given to the agent untouched. */
export const mentionsSession = (prompt: readonly unknown[]): boolean =>
  prompt.some((block) => mentionedSession(block) !== undefined);

/** A person's message as words: a mention is its name after an @, an image is said to be there. */
const wordsOf = (content: unknown): string => {
  const blocks = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  for (const raw of blocks) {
    const b = raw as Block | null;
    if (b === null || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") parts.push("[image]");
    else if (b.type === "resource_link") {
      // Said in the words already when it was picked in Cycle's box.
      const said = metaOf(b)?.["cycle/mention"];
      if (typeof said !== "string") parts.push(`@${String(b.name ?? b.uri ?? "")}`);
    } else if (b.type === "resource") {
      const uri = (b.resource as { uri?: unknown } | undefined)?.uri;
      parts.push(`[${typeof uri === "string" ? uri : "attachment"}]`);
    }
  }
  return parts.join(" ").trim();
};

/**
 * What was said in a session, oldest first: the person's messages, and the agent's replies with each reply's chunks
 * put together. No thoughts, tool calls, their output, plans or permissions.
 */
export const conversationOf = (records: readonly LogRecord[]): Said[] => {
  const said: Said[] = [];
  let reply: { messageId: unknown; at: number } | undefined;
  for (const record of records) {
    if (record.kind !== "update") continue;
    const update = record.data as Record<string, unknown> | null;
    if (update === null || typeof update !== "object") continue;
    if (update.sessionUpdate === "user_message") {
      const text = wordsOf(update.content);
      if (text !== "") said.push({ from: "user", text });
      reply = undefined;
    } else if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content as Block | undefined;
      if (content?.type !== "text" || typeof content.text !== "string") continue;
      const last = reply !== undefined ? said[reply.at] : undefined;
      if (last !== undefined && reply?.messageId === update.messageId) {
        last.text += content.text;
      } else {
        said.push({ from: "agent", text: content.text });
        reply = { messageId: update.messageId, at: said.length - 1 };
      }
    }
  }
  return said.map((s) => ({ from: s.from, text: s.text.trim() })).filter((s) => s.text !== "");
};

/** A message cannot end the tag it is in. */
const closing = (text: string): string => text.replace(/<\/message/gi, "<\\/message");

const cut = (text: string, limit: number): string =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[… ${text.length - limit} more characters left out]`;

/**
 * The record of a session as the agent reads it: a line on what it is, then the messages, newest kept. Each message
 * is cut to `messageChars`; past `chars` in all, the oldest messages are left out whole, and the first line says how
 * many.
 */
export const transcriptOf = (
  sessionId: string,
  title: string | undefined,
  said: readonly Said[],
  limits: { messageChars: number; chars: number } = SESSION_MENTION_LIMITS,
): string => {
  const kept: string[] = [];
  let used = 0;
  for (let at = said.length - 1; at >= 0; at -= 1) {
    const s = said[at] as Said;
    const line = `<message from="${s.from}">\n${closing(cut(s.text, limits.messageChars))}\n</message>`;
    if (used + line.length > limits.chars && kept.length > 0) break;
    kept.unshift(line);
    used += line.length + 2;
  }
  const dropped = said.length - kept.length;
  const name = title !== undefined && title !== "" ? `"${title}" (${sessionId})` : sessionId;
  const head = [
    `The user mentioned another Cycle session, ${name}. This is what was said in it: the user's messages and the agent's replies, without tool calls or their output.`,
    dropped > 0
      ? `The ${dropped} earliest ${dropped === 1 ? "message is" : "messages are"} left out for length.`
      : undefined,
    said.length === 0 ? "Nothing has been said in it yet." : undefined,
  ].filter((line): line is string => line !== undefined);
  return [head.join(" "), ...kept].join("\n\n");
};

const WHY: Record<"missing" | "unreadable" | "self", string> = {
  missing: "it is not a session of this Cycle daemon, or it has been deleted",
  unreadable: "its history could not be read",
  self: "it is this session, whose conversation you already have",
};

/** What the agent is told in place of a session it cannot be given. */
export const missingNote = (
  sessionId: string,
  name: string | undefined,
  why: keyof typeof WHY,
): string =>
  `[The user mentioned the Cycle session ${name !== undefined && name !== "" ? `"${name}" ` : ""}(${sessionId}), but its conversation is not included: ${WHY[why]}.]`;

/**
 * The prompt as the agent is given it: each mention of a session replaced, in place, by that session's record (an
 * embedded resource where the agent takes them, text where it does not), or by a note on why there is none. Every
 * block put in carries the mention it stands for, to be put back by `collapseSessionMentions`. A prompt that mentions
 * no session is returned as it is.
 */
export const expandSessionMentions = async (
  prompt: readonly unknown[],
  read: (sessionId: string) => Promise<Mentioned>,
  embedded: boolean,
): Promise<unknown[]> => {
  if (!mentionsSession(prompt)) return [...prompt];
  const out: unknown[] = [];
  for (const block of prompt) {
    const sessionId = mentionedSession(block);
    if (sessionId === undefined) {
      out.push(block);
      continue;
    }
    const link = block as Block;
    const name = typeof link.name === "string" ? link.name : undefined;
    const meta = { [META.expandedFrom]: link };
    const found = await read(sessionId).catch(
      (): Mentioned => ({ found: false, why: "unreadable" }),
    );
    if (!found.found) {
      out.push({ type: "text", text: missingNote(sessionId, name, found.why), _meta: meta });
      continue;
    }
    const text = transcriptOf(sessionId, found.title ?? name, conversationOf(found.records));
    out.push(
      embedded
        ? {
            type: "resource",
            resource: { uri: String(link.uri), mimeType: "text/plain", text },
            _meta: meta,
          }
        : { type: "text", text, _meta: meta },
    );
  }
  return out;
};

/** The agent's echo of a prompt as it is kept: every block the daemon put in for a mention is the mention again. */
export const collapseSessionMentions = (content: unknown): unknown => {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((block) => {
    const from = metaOf((block ?? {}) as Block)?.[META.expandedFrom];
    if (typeof from !== "object" || from === null) return block;
    changed = true;
    return from;
  });
  return changed ? out : content;
};
