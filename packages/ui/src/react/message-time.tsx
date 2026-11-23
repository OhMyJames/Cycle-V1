// When a message was sent or a reply finished: a muted relative time that shows with the message under the pointer or
// on keyboard focus, and says the full local date and time in its tip. Nothing when the time is not known.
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { useSyncExternalStore } from "react";
import { fullTime, relativeTime } from "../message-time.ts";
import { useI18n } from "./i18n.tsx";

/** How often the words move on. Finer than a minute would show nothing new. */
const TICK_MS = 30_000;

/** One clock for every time on the page, running only while one is drawn. */
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
        for (const each of [...listeners]) each();
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

export function MessageTime({ at, kind }: { at: number | undefined; kind: "sent" | "finished" }) {
  const i18n = useI18n();
  const now = useSyncExternalStore(ticker.subscribe, ticker.now, ticker.now);
  if (at === undefined) return null;
  return (
    <Tooltip type="description">
      {/* The trigger is a button, so Tab reaches it and the full time is there without a pointer; it does nothing when
          pressed. `data-kind`: the trigger sets its own slot. */}
      <TooltipTrigger data-kind="message-time">
        <time dateTime={new Date(at).toISOString()}>{relativeTime(i18n, at, now)}</time>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4} collisionPadding={8}>
        {i18n.t(kind === "sent" ? "time.sent" : "time.finished", { time: fullTime(i18n, at) })}
      </TooltipContent>
    </Tooltip>
  );
}
