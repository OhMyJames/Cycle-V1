// When a message was sent, in words: "Just now", "3 minutes ago", "yesterday", then the date. The words come from
// Intl in the interface's language, so zh-CN reads "3分钟前" and "昨天". No React and no DOM, so it is tested plainly.
import type { Translator } from "./i18n.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `at` relative to `now`, both in milliseconds since the epoch. Within a minute (or a time a little ahead of this
 * machine's clock: the daemon's may run fast) it is "just now"; then minutes, hours, days up to a week; then the date.
 */
export const relativeTime = (i18n: Translator, at: number, now: number): string => {
  const ago = now - at;
  if (ago < MINUTE) return i18n.t("time.justNow");
  const words = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" });
  if (ago < HOUR) return words.format(-Math.floor(ago / MINUTE), "minute");
  if (ago < DAY) return words.format(-Math.floor(ago / HOUR), "hour");
  if (ago < 7 * DAY) return words.format(-Math.floor(ago / DAY), "day");
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return i18n.date(at, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

/** `at` in full, in this machine's time zone: what the relative words stand for. */
export const fullTime = (i18n: Translator, at: number): string =>
  i18n.date(at, { dateStyle: "full", timeStyle: "short" });
