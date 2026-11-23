import { memo, useSyncExternalStore } from "react";
import { fullTime, relativeTime } from "../relative-time.ts";
import { useI18n } from "./i18n.tsx";

/** How often the times move on. The finest they say is a minute. */
const TICK_MS = 60_000;

/**
 * One clock for every time on the page, running only while one is shown. A tick redraws the times, not the rows or the
 * list around them.
 */
const ticker = (() => {
  const listeners = new Set<() => void>();
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      now = Date.now();
      timer ??= setInterval(() => {
        now = Date.now();
        for (const each of listeners) each();
      }, TICK_MS);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    now: () => now,
  };
})();

/**
 * When a session last changed (its `updatedAt`), short, at the end of its row: "5m ago". The whole date and time on
 * hover. Nothing when the daemon does not say (an older one) or says something that is not a time.
 */
export const SessionTime = memo(function SessionTime({ at }: { at: string | undefined }) {
  const { locale } = useI18n();
  const now = useSyncExternalStore(ticker.subscribe, ticker.now);
  const time = at === undefined ? Number.NaN : Date.parse(at);
  if (Number.isNaN(time)) return null;
  return (
    <time
      data-slot="session-time"
      dateTime={new Date(time).toISOString()}
      title={fullTime(time, locale)}
    >
      {relativeTime(time, now, locale)}
    </time>
  );
});
