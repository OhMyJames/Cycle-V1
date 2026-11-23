// When a message was sent, in words: "Just now", "3 minutes ago", "yesterday", then the date. The words come from
// Intl in the interface's language, so zh-CN reads "3分钟前" and "昨天". No React and no DOM, so it is tested plainly.
import type { Translator } from "./i18n.ts";
import { relativeTime as relativeTimeIn } from "./relative-time.ts";

const MINUTE = 60_000;

/**
 * `at` relative to `now`, both in milliseconds since the epoch, in the words a message has room for. Within a minute (or
 * a time a little ahead of this machine's clock: the daemon's may run fast) it is "just now"; past that it is the
 * sidebar's rule (`relative-time.ts`) in its long style: minutes, hours, days up to a week, then the date.
 */
export const relativeTime = (i18n: Translator, at: number, now: number): string =>
  now - at < MINUTE ? i18n.t("time.justNow") : relativeTimeIn(at, now, i18n.locale, "long");

/** `at` in full, in this machine's time zone: what the relative words stand for. */
export const fullTime = (i18n: Translator, at: number): string =>
  i18n.date(at, { dateStyle: "full", timeStyle: "short" });
