// What is written in the message box of each session, and the images attached to it, so that switching to another session and
// back does not lose it. Pure TypeScript with no React and no DOM: the Composer reads it through useSyncExternalStore, and it
// is tested on its own. Kept in the page's memory only: an image can be many megabytes, and what someone half-wrote may be
// something they would not want kept on disk, so a reload starts clean.
import type { Attachment } from "./attachments.ts";

export type Draft = { readonly text: string; readonly attachments: readonly Attachment[] };

/** The draft of a session that has none. One object, so that reading it twice is the same value. */
export const EMPTY_DRAFT: Draft = Object.freeze({ text: "", attachments: Object.freeze([]) });

/** How many drafts are kept: the one written to longest ago is dropped past this. */
export const MAX_DRAFTS = 20;

const isEmpty = (draft: Draft): boolean => draft.text === "" && draft.attachments.length === 0;

export const createDraftStore = () => {
  // In the order they were last written: the oldest is first.
  const drafts = new Map<string, Draft>();
  const generations = new Map<string, number>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: (key: string): Draft => drafts.get(key) ?? EMPTY_DRAFT,
    /** Changes a draft from what it is now (not from what the caller saw earlier: a read that took a while may add to it). */
    update: (key: string, change: (draft: Draft) => Draft): void => {
      const before = drafts.get(key) ?? EMPTY_DRAFT;
      const after = change(before);
      if (after === before) return;
      drafts.delete(key);
      if (!isEmpty(after)) {
        drafts.set(key, after);
        const oldest = drafts.keys().next();
        if (drafts.size > MAX_DRAFTS && oldest.done !== true) drafts.delete(oldest.value);
      }
      notify();
    },
    /**
     * The message was sent: the draft is gone, and an image still being read for it is not for the next message. A read
     * asks for `generation` before, and gives up if it has changed since.
     */
    sent: (key: string): void => {
      generations.set(key, (generations.get(key) ?? 0) + 1);
      if (drafts.delete(key)) notify();
    },
    generation: (key: string): number => generations.get(key) ?? 0,
    /** The session is gone: so is what was written for it. */
    forget: (key: string): void => {
      generations.delete(key);
      if (drafts.delete(key)) notify();
    },
    /** Every draft of a host (its sessions' keys begin with its id and a colon). */
    forgetHost: (hostId: string): void => {
      let any = false;
      for (const key of [...drafts.keys()]) {
        if (key.startsWith(`${hostId}:`)) {
          drafts.delete(key);
          generations.delete(key);
          any = true;
        }
      }
      if (any) notify();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export type DraftStore = ReturnType<typeof createDraftStore>;
