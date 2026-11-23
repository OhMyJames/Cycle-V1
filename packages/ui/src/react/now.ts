// One clock for every relative time on the page (a session row's, a message's), running only while one is shown. A tick
// redraws the times that read it, not the rows or the lists around them.
import { useSyncExternalStore } from "react";

/** How often the times move on. The finest they say is a minute; half of one keeps them from lagging by most of it. */
const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  now = Date.now();
  timer ??= setInterval(() => {
    now = Date.now();
    for (const each of [...listeners]) each();
  }, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

const read = (): number => now;

/** Now, in epoch milliseconds, as of the clock's last tick. */
export const useNow = (): number => useSyncExternalStore(subscribe, read, read);
