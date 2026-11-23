// How long ago something was, in the few characters a row of the sidebar has for it. No React and no DOM.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Past this many days the date says more than a count of them. */
const DAYS = 7;

const formats = new Map<string, Intl.RelativeTimeFormat>();
/** One formatter per language, not one per row each minute. */
const relativeFormat = (locale: string): Intl.RelativeTimeFormat => {
  let format = formats.get(locale);
  if (format === undefined) {
    format = new Intl.RelativeTimeFormat(locale, { style: "narrow", numeric: "auto" });
    formats.set(locale, format);
  }
  return format;
};

/** Whole local days from `then` to `now`: 1 for any time yesterday, whatever the hour. */
const daysBetween = (then: Date, now: Date): number => {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(now) - start(then)) / (24 * HOUR));
};

/**
 * `at` (epoch milliseconds) as a short time relative to `now`, in `locale`: "now", "5m ago", "3h ago" (up to a
 * day), "yesterday", "4d ago", then the date ("Mar 4", with the year when it is not this one). zh-CN: 现在, 5分钟前, 3小时前, 昨天, 4天前, 3月4日.
 * A time ahead of `now` (another machine's clock) is "now".
 */
export const relativeTime = (at: number, now: number, locale: string): string => {
  const ago = Math.max(0, now - at);
  const relative = relativeFormat(locale);
  if (ago < MINUTE) return relative.format(0, "second");
  if (ago < HOUR) return relative.format(-Math.floor(ago / MINUTE), "minute");
  const then = new Date(at);
  const today = new Date(now);
  if (ago < 24 * HOUR) return relative.format(-Math.floor(ago / HOUR), "hour");
  const days = daysBetween(then, today);
  if (days < DAYS) return relative.format(-Math.max(1, days), "day");
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  }).format(then);
};

/** The whole local date and time, for where there is room to say it: "Mar 4, 2026, 3:03 PM". */
export const fullTime = (at: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
