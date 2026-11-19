// The model of a conversation: what a stream of ACP v2 `session/update`s adds up to.
//
// Pure TypeScript with no React and no DOM, because the Electron main process holds a conversation
// per session too (a renderer that reloads must get it back whole) and main is not a browser.
//
// ACP v2's rules for updates (see the SDK's v2 header): an omitted field stays as it was, `null`
// clears it, any other value replaces it, and chunks append. Entities are patched by their id.
import type { SessionUpdate } from "@cycle/acp";

/** A piece of content. Only `text` and `image` are drawn; anything else is kept and shown plainly. */
export type Block = { type: string; [key: string]: unknown };

export type ToolStatus =
  | "pending"
  | "in_progress"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Every item says which turn it began in: the number of turns that had ended before it. A turn is what ACP v2 leaves
 * out (it has only `running` and `idle`), but the daemon's log keeps how each one ended, so it can be told from the
 * data, in a live stream and in a replay alike, with nothing inferred from the text.
 */
type InTurn = { turn: number };

export type UserItem = InTurn & { kind: "user"; id: string; blocks: Block[] };
export type AgentItem = InTurn & { kind: "agent"; id: string; blocks: Block[] };
export type ThoughtItem = InTurn & { kind: "thought"; id: string; blocks: Block[] };
export type ToolItem = InTurn & {
  kind: "tool";
  id: string;
  name?: string;
  toolKind?: string;
  status?: string;
  content: Block[];
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: { path: string; line?: number | null }[];
};
export type PlanEntry = { content: string; priority: string; status: string };
export type Usage = { used: number; size: number; cost?: { amount: number; currency: string } };

/** What the header says: how full the context is, and what the session has cost. */
export const usageLabel = (usage: Usage): string => {
  const percent = usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0;
  const parts = [`${percent}% of context`];
  if (usage.cost !== undefined) {
    parts.push(
      usage.cost.currency === "USD"
        ? `$${usage.cost.amount.toFixed(usage.cost.amount < 0.1 ? 3 : 2)}`
        : `${usage.cost.amount} ${usage.cost.currency}`,
    );
  }
  return parts.join(" · ");
};

export type PlanItem = InTurn & { kind: "plan"; id: string; entries: PlanEntry[] };
export type NoticeItem = InTurn & { kind: "notice"; id: string; severity: string; title: string };

export type Item = UserItem | AgentItem | ThoughtItem | ToolItem | PlanItem | NoticeItem;

export type Status = "idle" | "running" | "requires_action";

export type StopReason = {
  stopReason: string;
  error?: { code?: number; message?: string } | null | undefined;
};

/** A prompt waiting for the agent, as the daemon holds it (docs/protocol.md §8). `queueId` is the daemon's. */
export type QueuedPrompt = { queueId: string; prompt: Block[] };

/** Prompts the daemon handed back, to be put in the input box. `serial` changes each time, so one is acted on once. */
export type Returned = { serial: number; prompts: QueuedPrompt[]; reason?: string };

/** A command the agent offers, typed as `/name` at the start of a message. */
export type Command = { name: string; description: string; hint?: string };

export type Conversation = {
  items: Item[];
  status: Status;
  /** Turns that have ended: an idle that says why. A bare idle is a snapshot and is not one. */
  turns: number;
  /** How each ended turn ended: `stops[n]` is turn n's. The turn still going has none. */
  stops: StopReason[];
  /** True from the start of a replay until `replay_complete`. */
  replaying: boolean;
  usage: Usage | undefined;
  /** The prompts sent while the agent works, oldest first: the last snapshot the daemon wrote. */
  queue: QueuedPrompt[];
  /** What the daemon last handed back. Only set when it arrives live: a replay never sets it. */
  returned: Returned | undefined;
  commands: Command[];
  /** Updates of a kind this version does not draw. */
  ignored: number;
};

export const emptyConversation = (): Conversation => ({
  items: [],
  status: "idle",
  turns: 0,
  stops: [],
  replaying: false,
  usage: undefined,
  queue: [],
  returned: undefined,
  commands: [],
  ignored: 0,
});

const queuedPrompts = (value: unknown): QueuedPrompt[] =>
  Array.isArray(value)
    ? value.flatMap((entry): QueuedPrompt[] => {
        const e = entry as { queueId?: unknown; prompt?: unknown } | null;
        return typeof e?.queueId === "string" && Array.isArray(e.prompt)
          ? [{ queueId: e.queueId, prompt: e.prompt as Block[] }]
          : [];
      })
    : [];

const commandsOf = (value: unknown): Command[] =>
  Array.isArray(value)
    ? value.flatMap((entry): Command[] => {
        const e = entry as {
          type?: unknown;
          name?: unknown;
          description?: unknown;
          input?: { type?: unknown; hint?: unknown } | null;
        } | null;
        // Only commands: an entry of another type is something this version does not offer.
        if (e === null || (e.type !== undefined && e.type !== "command")) return [];
        if (typeof e.name !== "string" || e.name === "") return [];
        const hint =
          e.input?.type === "text" && typeof e.input.hint === "string" ? e.input.hint : "";
        return [
          {
            name: e.name,
            description: typeof e.description === "string" ? e.description : "",
            ...(hint === "" ? {} : { hint }),
          },
        ];
      })
    : [];

const FINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

type Fields = Record<string, unknown>;

/** The ACP patch rule for one field: undefined keeps the old value, null clears, else replaces. */
const patch = <T>(old: T | undefined, next: unknown): T | undefined => {
  if (next === undefined) return old;
  if (next === null) return undefined;
  return next as T;
};

const keyOf = (item: Item): string => `${item.kind}:${item.id}`;

const upsert = (items: Item[], next: Item): Item[] => {
  const key = keyOf(next);
  const at = items.findIndex((item) => keyOf(item) === key);
  if (at === -1) return [...items, next];
  const copy = items.slice();
  copy[at] = next;
  return copy;
};

const find = <K extends Item["kind"]>(items: Item[], kind: K, id: string) =>
  items.find((item) => item.kind === kind && item.id === id) as
    | Extract<Item, { kind: K }>
    | undefined;

const asBlocks = (content: unknown): Block[] =>
  Array.isArray(content) ? (content as Block[]) : [];

/** Appends a block, joining text onto the text before it so a stream is one run of text. */
const appendBlock = (blocks: Block[], block: Block): Block[] => {
  const last = blocks.at(-1);
  if (block.type === "text" && last?.type === "text") {
    return [...blocks.slice(0, -1), { ...last, text: String(last.text) + String(block.text) }];
  }
  return [...blocks, block];
};

const messageUpdate = (
  c: Conversation,
  kind: "user" | "agent" | "thought",
  update: Fields,
  chunk: boolean,
): Conversation => {
  const id = String(update.messageId);
  const old = find(c.items, kind, id);
  let blocks = old?.blocks ?? [];
  if (chunk) {
    if (update.content !== undefined && update.content !== null) {
      blocks = appendBlock(blocks, update.content as Block);
    }
  } else if (update.content === null) {
    blocks = [];
  } else if (update.content !== undefined) {
    blocks = asBlocks(update.content);
  }
  return { ...c, items: upsert(c.items, { kind, id, blocks, turn: old?.turn ?? c.turns }) };
};

const toolUpdate = (c: Conversation, update: Fields): Conversation => {
  const id = String(update.toolCallId);
  const old = find(c.items, "tool", id);
  const next: ToolItem = {
    kind: "tool",
    id,
    turn: old?.turn ?? c.turns,
    content: old?.content ?? [],
  };
  const name = patch(old?.name, update.name);
  const toolKind = patch(old?.toolKind, update.kind);
  const status = patch(old?.status, update.status);
  const content =
    update.content === undefined ? old?.content : update.content === null ? [] : update.content;
  const rawInput = update.rawInput === undefined ? old?.rawInput : update.rawInput;
  const rawOutput = update.rawOutput === undefined ? old?.rawOutput : update.rawOutput;
  const locations = patch(old?.locations, update.locations);
  if (name !== undefined) next.name = name;
  if (toolKind !== undefined) next.toolKind = toolKind;
  if (status !== undefined) next.status = status;
  next.content = asBlocks(content);
  if (rawInput !== undefined) next.rawInput = rawInput;
  if (rawOutput !== undefined) next.rawOutput = rawOutput;
  if (locations !== undefined) next.locations = locations;
  return { ...c, items: upsert(c.items, next) };
};

const stateUpdate = (c: Conversation, update: Fields): Conversation => {
  const state = update.state;
  if (state !== "running" && state !== "idle" && state !== "requires_action")
    return { ...c, ignored: c.ignored + 1 };
  if (state !== "idle") return { ...c, status: state };
  const reason = update.stopReason;
  // An idle with no stopReason is a snapshot of the state, not the end of a turn: apply it, count nothing.
  if (typeof reason !== "string") return { ...c, status: "idle" };
  // Work that was still going when the turn ended will not finish, however the turn ended: the agent
  // says so for a call it left (it ends it as cancelled), and a record made before it did is read the same.
  const items = c.items.map((item) =>
    item.kind === "tool" && item.status !== undefined && !FINAL.has(item.status)
      ? { ...item, status: "cancelled" }
      : item,
  );
  const stop: StopReason = { stopReason: reason };
  if (update.error !== undefined) stop.error = update.error as StopReason["error"];
  return { ...c, items, status: "idle", turns: c.turns + 1, stops: [...c.stops, stop] };
};

/** Applies one `session/update`. Returns a new conversation; the old one is not changed. */
export const applyUpdate = (c: Conversation, update: SessionUpdate): Conversation => {
  const u = update as unknown as Fields;
  switch (u.sessionUpdate) {
    case "user_message":
      return messageUpdate(c, "user", u, false);
    case "user_message_chunk":
      return messageUpdate(c, "user", u, true);
    case "agent_message":
      return messageUpdate(c, "agent", u, false);
    case "agent_message_chunk":
      return messageUpdate(c, "agent", u, true);
    case "agent_thought":
      return messageUpdate(c, "thought", u, false);
    case "agent_thought_chunk":
      return messageUpdate(c, "thought", u, true);
    case "tool_call_update":
      return toolUpdate(c, u);
    case "tool_call_content_chunk": {
      const old = find(c.items, "tool", String(u.toolCallId));
      const content = appendBlock(old?.content ?? [], (u.content ?? {}) as Block);
      return toolUpdate(c, { toolCallId: u.toolCallId, content });
    }
    case "state_update":
      return stateUpdate(c, u);
    case "plan_update": {
      const plan = u.plan as { type?: string; planId?: string; entries?: PlanEntry[] } | undefined;
      if (plan?.type !== "items" || plan.planId === undefined)
        return { ...c, ignored: c.ignored + 1 };
      const old = find(c.items, "plan", plan.planId);
      return {
        ...c,
        items: upsert(c.items, {
          kind: "plan",
          id: plan.planId,
          turn: old?.turn ?? c.turns,
          entries: plan.entries ?? [],
        }),
      };
    }
    case "notice": {
      const id = `notice-${c.items.length}`;
      return {
        ...c,
        items: [
          ...c.items,
          {
            kind: "notice",
            id,
            turn: c.turns,
            severity: String(u.severity),
            title: String(u.title),
          },
        ],
      };
    }
    case "usage_update": {
      // The cost: omitted keeps the last one, null clears it, a value replaces it.
      const given = u.cost as { amount: number; currency: string } | null | undefined;
      const cost = given === undefined ? c.usage?.cost : (given ?? undefined);
      return {
        ...c,
        usage: {
          used: Number(u.used),
          size: Number(u.size),
          ...(cost !== undefined ? { cost } : {}),
        },
      };
    }
    case "replay_complete":
      return { ...c, replaying: false };
    case "_cycle/queue_update": {
      const returned = queuedPrompts(u.returned);
      return {
        ...c,
        queue: queuedPrompts(u.entries),
        // Handed back is an event: heard live, it goes to the input box once; in a replay it is history.
        ...(returned.length > 0 && !c.replaying
          ? {
              returned: {
                serial: (c.returned?.serial ?? 0) + 1,
                prompts: returned,
                ...(typeof u.reason === "string" ? { reason: u.reason } : {}),
              },
            }
          : {}),
      };
    }
    case "available_commands_update":
      return { ...c, commands: commandsOf(u.availableCommands) };
    case "config_option_update":
    case "session_info_update":
      // Known, and not drawn in the conversation.
      return c;
    default:
      return { ...c, ignored: c.ignored + 1 };
  }
};

/** The conversation after `updates`, applied in order. */
export const reduce = (
  updates: SessionUpdate[],
  from: Conversation = emptyConversation(),
): Conversation => updates.reduce(applyUpdate, from);

/** What the composer may do: a turn is over and nothing waits for the user. */
export const canPrompt = (c: Conversation): boolean => c.status === "idle";

/** The text of a message's blocks, for copying and for tests. */
export const textOf = (blocks: Block[]): string =>
  blocks.map((b) => (b.type === "text" ? String(b.text) : "")).join("");
