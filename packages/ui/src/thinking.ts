// Whether the conversation shows the agent's thinking. A preference of this machine, kept in the page's storage; off
// by default, because thinking is long and most of the time not what the person came to read. No React and no DOM
// here, so it can be tested with a fake storage.
import type { Storage } from "./code-theme.ts";

export const THINKING_KEY = "cycle-show-thinking";

export const createThinkingStore = (storage: Storage | undefined) => {
  const listeners = new Set<() => void>();
  let current = false;
  try {
    current = storage?.getItem(THINKING_KEY) === "true";
  } catch {
    // Storage that cannot be read: thinking stays hidden.
  }
  return {
    get: (): boolean => current,
    set: (show: boolean): void => {
      if (show === current) return;
      current = show;
      try {
        storage?.setItem(THINKING_KEY, String(show));
      } catch {
        // Not saved, but the choice holds for this run.
      }
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** The one the page uses. */
export const thinking = createThinkingStore(
  typeof localStorage === "undefined" ? undefined : localStorage,
);
