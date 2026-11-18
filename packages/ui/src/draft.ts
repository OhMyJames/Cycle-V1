// What the person has written and not sent, kept per session, and the rules around it. Plain TypeScript: no React, no
// DOM, so that the rules can be tested. The text is kept in the renderer's localStorage by host and session, so a
// restart finds it again. The images are not: base64 of a picture would fill the little room localStorage has.
import type { PromptBlock } from "./api.ts";
import { ATTACHMENT_LIMITS, type Attachment, base64Bytes, isImageType } from "./attachments.ts";
import type { Block, QueuedPrompt } from "./model/index.ts";
import { textOf } from "./model/index.ts";

/**
 * A file or folder picked after an @. The message holds `@path` as text, which is what a person reads; this is what
 * goes with it for the agent (docs/protocol.md §8). Kept with the draft in memory only: text that comes back from
 * storage is just text.
 */
export type Mention = {
  /** Relative to the session's folder, as in the text after the @. */
  readonly path: string;
  readonly kind: "file" | "folder";
  /** `file://` and the absolute path, a folder's ending in `/`. */
  readonly uri: string;
  readonly name: string;
};

export type Draft = {
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly mentions: readonly Mention[];
};

const EMPTY: Draft = { text: "", attachments: [], mentions: [] };

/** What the text says of a mention: the @ and the path, and a slash after a folder's. */
export const mentionText = (mention: Pick<Mention, "path" | "kind">): string =>
  `@${mention.path}${mention.kind === "folder" ? "/" : ""}`;

/** The `file://` address of a path under a root, as the agent reads it. */
export const fileUri = (root: string, path: string, kind: "file" | "folder"): string =>
  `file://${`${root.replace(/\/$/, "")}/${path}`.split("/").map(encodeURIComponent).join("/")}${kind === "folder" ? "/" : ""}`;

/** The key of a mention in a link's `_meta`: the path as the text says it, so that a link that comes back is a mention again. */
export const MENTION_META = "cycle/mention";

/** The part of `Storage` a draft needs. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "cycle:draft:";

/** The browser's storage, if there is one and it may be used: reading it can throw where a page may not. */
export const browserStorage = (): DraftStorage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

type Saved = { text?: string; handled?: string };

/** What a message is sent as: its text, then its images. Undefined when there is nothing to send. */
export const promptBlocks = (draft: Draft): PromptBlock[] | undefined => {
  if (draft.text.trim() === "" && draft.attachments.length === 0) return undefined;
  const text = draft.text.trim() === "" ? [] : [{ type: "text" as const, text: draft.text }];
  const images = draft.attachments.map((a) => ({
    type: "image" as const,
    data: a.data,
    mimeType: a.type,
  }));
  // Only what the text still says: a mention whose @path was deleted is not sent. Once for each address. Blocks are
  // few (the same limit images are held to), and the words say it all when a link has no room.
  const seen = new Set<string>();
  const links = draft.mentions
    .filter((m) => draft.text.includes(mentionText(m)) && !seen.has(m.uri) && seen.add(m.uri))
    .map((m) => ({
      type: "resource_link" as const,
      name: m.name,
      uri: m.uri,
      _meta: { [MENTION_META]: m.path },
    }))
    .slice(0, Math.max(0, ATTACHMENT_LIMITS.blocks - text.length - images.length));
  return [...text, ...images, ...links];
};

/** A prompt's blocks as a draft: its texts, and its images as attachments. Other blocks are left out. */
export const draftOf = (blocks: readonly Block[]): Draft => {
  const texts: string[] = [];
  const attachments: Attachment[] = [];
  const mentions: Mention[] = [];
  for (const block of blocks) {
    if (block.type === "resource_link") {
      const path = (block._meta as Record<string, unknown> | undefined)?.[MENTION_META];
      if (typeof block.uri === "string" && typeof path === "string") {
        mentions.push({
          path,
          kind: block.uri.endsWith("/") ? "folder" : "file",
          uri: block.uri,
          name: typeof block.name === "string" ? block.name : path,
        });
      }
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      isImageType(block.mimeType)
    ) {
      attachments.push({
        id: crypto.randomUUID(),
        name: typeof block.name === "string" ? block.name : "image",
        type: block.mimeType,
        data: block.data,
        bytes: base64Bytes(block.data) ?? 0,
      });
    }
  }
  return { text: texts.join(""), attachments, mentions };
};

/** What identifies a hand-back, so one that was put in the box is not put there twice. */
export const returnedId = (prompts: readonly QueuedPrompt[]): string =>
  prompts.map((p) => p.queueId).join("|");

export class DraftStore {
  readonly #storage: DraftStorage | undefined;
  readonly #drafts = new Map<string, Draft>();
  readonly #handled = new Map<string, string>();
  readonly #loaded = new Set<string>();
  readonly #generations = new Map<string, number>();
  // Per host: a removed host tells every read in flight for any of its sessions, also those with no count of their own yet.
  readonly #epochs = new Map<string, number>();
  readonly #listeners = new Set<() => void>();

  constructor(storage: DraftStorage | undefined = browserStorage()) {
    this.#storage = storage;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #load(key: string): void {
    if (this.#loaded.has(key)) return;
    this.#loaded.add(key);
    try {
      const raw = this.#storage?.getItem(PREFIX + key);
      if (raw === null || raw === undefined) return;
      const saved = JSON.parse(raw) as Saved;
      if (typeof saved.text === "string" && saved.text !== "") {
        this.#drafts.set(key, { text: saved.text, attachments: [], mentions: [] });
      }
      if (typeof saved.handled === "string") this.#handled.set(key, saved.handled);
    } catch {
      // Unreadable: it is as if there were no draft. It is written over by the next change.
    }
  }

  #save(key: string): void {
    const text = this.#drafts.get(key)?.text ?? "";
    const handled = this.#handled.get(key);
    try {
      if (text === "" && handled === undefined) this.#storage?.removeItem(PREFIX + key);
      else this.#storage?.setItem(PREFIX + key, JSON.stringify({ text, handled }));
    } catch {
      // Full, or not allowed: the draft stays in memory, and is lost with the window.
    }
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /** The draft of a session. The same object until it changes, so that it can be watched. */
  get(key: string): Draft {
    this.#load(key);
    return this.#drafts.get(key) ?? EMPTY;
  }

  #put(key: string, draft: Draft): void {
    this.#load(key);
    if (draft.text === "" && draft.attachments.length === 0 && draft.mentions.length === 0)
      this.#drafts.delete(key);
    else this.#drafts.set(key, draft);
    this.#save(key);
    this.#changed();
  }

  setText(key: string, text: string): void {
    const old = this.get(key);
    if (old.text === text) return;
    this.#put(key, { ...old, text });
  }

  setAttachments(key: string, attachments: readonly Attachment[]): void {
    this.#put(key, { ...this.get(key), attachments });
  }

  /** A file or folder picked after an @. Picking it again changes nothing. */
  addMention(key: string, mention: Mention): void {
    const old = this.get(key);
    if (old.mentions.some((m) => m.uri === mention.uri)) return;
    this.#put(key, { ...old, mentions: [...old.mentions, mention] });
  }

  /** The draft is gone: it was sent, or the session was deleted. */
  clear(key: string): void {
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    this.#put(key, EMPTY);
  }

  /**
   * Changes whenever the draft is sent or its session goes. A read that takes a while (an image) asks for it before and
   * gives up if it has changed: what it read is for a message that is gone. The count only goes up, so a count that came
   * back to what the read saw cannot let it write the draft again.
   */
  generation(key: string): number {
    const host = key.slice(0, Math.max(0, key.indexOf(":")));
    return (this.#generations.get(key) ?? 0) + (this.#epochs.get(host) ?? 0);
  }

  /** Forgets everything about a session, including which hand-backs were put in its box. */
  forget(key: string): void {
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    this.#load(key);
    this.#drafts.delete(key);
    this.#handled.delete(key);
    this.#save(key);
    this.#changed();
  }

  /**
   * Every draft of a host, in memory and in storage. A session's key is its host's id, a colon and its id, and a host's id
   * has no colon (`local`, or `ssh-` and letters, digits and hyphens), so the prefix names one host's sessions only.
   */
  forgetHost(hostId: string): void {
    const prefix = `${hostId}:`;
    this.#epochs.set(hostId, (this.#epochs.get(hostId) ?? 0) + 1);
    const keys = new Set([...this.#drafts.keys(), ...this.#handled.keys()]);
    try {
      for (let i = 0; i < (this.#storage?.length ?? 0); i += 1) {
        const name = this.#storage?.key(i);
        if (name?.startsWith(PREFIX + prefix) === true) keys.add(name.slice(PREFIX.length));
      }
    } catch {
      // Storage may not be read: what is in memory is still dropped.
    }
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      this.#loaded.add(key);
      this.#drafts.delete(key);
      this.#handled.delete(key);
      this.#save(key);
    }
    this.#changed();
  }

  /**
   * Puts what came back (a hand-back, a queued prompt taken back to edit, a message that did not go) in front of what
   * has been written since, as a person would want to read it: the older words first.
   */
  restore(key: string, blocks: readonly (readonly Block[])[]): void {
    const old = this.get(key);
    const back = blocks.map(draftOf);
    const text = [...back.map((d) => d.text), old.text].filter((t) => t !== "").join("\n\n");
    this.#put(key, {
      text,
      attachments: [...back.flatMap((d) => d.attachments), ...old.attachments],
      mentions: [...back.flatMap((d) => d.mentions), ...old.mentions],
    });
  }

  /** Whether a hand-back was already put in the session's box. */
  handled(key: string, id: string): boolean {
    this.#load(key);
    return this.#handled.get(key) === id;
  }

  markHandled(key: string, id: string): void {
    this.#load(key);
    this.#handled.set(key, id);
    this.#save(key);
  }
}

// ---- recalling what was sent ----

/** Where the person is in the messages they sent: `index` counts back from the last, none when not recalling. */
export type Recall = { readonly index: number | undefined; readonly shown: string | undefined };

export const NOT_RECALLING: Recall = { index: undefined, shown: undefined };

/** The texts of the messages the person sent, oldest first, for the arrow keys to walk. */
export const sentTexts = (items: readonly { kind: string; blocks?: Block[] }[]): string[] =>
  items.flatMap((item) => {
    if (item.kind !== "user") return [];
    const text = textOf(item.blocks ?? []);
    return text.trim() === "" ? [] : [text];
  });

/**
 * Up recalls the message before the one shown (the last, to begin with) and down the one after it, back to what was
 * being written. Only from an empty box, or from one that shows what was recalled: in any other text the arrows are the
 * caret's. Undefined is "not for us": let the key do what it does.
 */
export const recall = (
  sent: readonly string[],
  state: Recall,
  current: string,
  key: "up" | "down",
): { text: string; state: Recall } | undefined => {
  const showing = state.index !== undefined && state.shown === current;
  if (key === "up") {
    if (!showing && current !== "") return undefined;
    const index = showing ? (state.index ?? 0) + 1 : 0;
    const text = sent[sent.length - 1 - index];
    if (text === undefined) return undefined;
    return { text, state: { index, shown: text } };
  }
  if (!showing || state.index === undefined) return undefined;
  if (state.index === 0) return { text: "", state: NOT_RECALLING };
  const index = state.index - 1;
  const text = sent[sent.length - 1 - index];
  if (text === undefined) return undefined;
  return { text, state: { index, shown: text } };
};
