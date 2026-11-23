/**
 * A prompt that mentions another session of the same daemon (docs/protocol.md §8 "提及(@)另一个 session"): a
 * `resource_link` to `cycle://session/<id>`, which the daemon turns into a short record of that session as it gives the
 * prompt to the agent.
 */
export const SESSION_URI_PREFIX = "cycle://session/";

export const sessionUri = (sessionId: string): string =>
  `${SESSION_URI_PREFIX}${encodeURIComponent(sessionId)}`;

/** The session a `cycle://session/` address names, or undefined for any other address. */
export const sessionIdOfUri = (uri: unknown): string | undefined => {
  if (typeof uri !== "string" || !uri.startsWith(SESSION_URI_PREFIX)) return undefined;
  try {
    const id = decodeURIComponent(uri.slice(SESSION_URI_PREFIX.length));
    return id === "" ? undefined : id;
  } catch {
    return undefined;
  }
};

/** How much of a mentioned session the agent is given: characters of one message, and of the whole record. */
export const SESSION_MENTION_LIMITS = {
  messageChars: 4_000,
  chars: 40_000,
} as const;
