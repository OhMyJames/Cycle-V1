// Asks the open conversation to bring one of its items into view (CYCL-88): the Overview's todo list or a background
// task goes back to where it began. A request, not state: each is answered once, by the conversation of that session.
// Plain TypeScript: the conversation and the card that holds the item listen.

export type RevealRequest = {
  /** `environmentId:sessionId`. */
  readonly sessionKey: string;
  /** The item: a tool call's id, or a plan's. */
  readonly itemId: string;
  /** Counts up, so that asking for the same item twice is asked twice. */
  readonly serial: number;
};

let current: RevealRequest | undefined;
let serial = 0;
const listeners = new Set<() => void>();

export const reveal = {
  /** Brings an item of a session's conversation into view, and marks it for a moment. */
  request(sessionKey: string, itemId: string): void {
    serial += 1;
    current = { sessionKey, itemId, serial };
    for (const listener of [...listeners]) listener();
  },
  get: (): RevealRequest | undefined => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Whether a laid block holds the item: the block's own item, or one of the calls of a stretch of work. */
export const blockHolds = (
  block: {
    kind: string;
    item?: { id: string };
    tools?: readonly { id: string }[];
    tool?: { id: string };
  },
  itemId: string,
): boolean =>
  block.item?.id === itemId ||
  block.tool?.id === itemId ||
  (block.tools?.some((tool) => tool.id === itemId) ?? false);
