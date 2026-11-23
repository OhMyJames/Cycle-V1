import { expect, test } from "bun:test";
import { fullTime, relativeTime } from "../src/relative-time.ts";

// Local times, so the days are the machine's days whatever its time zone.
const now = new Date(2026, 10, 22, 15, 0).getTime();
const at = (...parts: [number, number, number, number?, number?]) => new Date(...parts).getTime();
const MINUTE = 60_000;

test("a short time ago reads in minutes, then hours, then days, then as a date", () => {
  const en = (t: number) => relativeTime(t, now, "en-US");
  expect(en(now - 20_000)).toBe("now");
  expect(en(now - 5 * MINUTE)).toBe("5m ago");
  expect(en(now - 3 * 60 * MINUTE - 59 * MINUTE)).toBe("3h ago");
  // Under a day is hours, even across midnight.
  expect(en(at(2026, 10, 21, 22, 0))).toBe("17h ago");
  expect(en(at(2026, 10, 21, 9, 0))).toBe("yesterday");
  expect(en(at(2026, 10, 18, 23, 0))).toBe("4d ago");
  expect(en(at(2026, 10, 3, 12, 0))).toBe("Nov 3");
  // Another year says which.
  expect(en(at(2025, 2, 4, 12, 0))).toBe("Mar 4, 2025");
});

test("it reads naturally in Chinese", () => {
  const zh = (t: number) => relativeTime(t, now, "zh-CN");
  expect(zh(now - 20_000)).toBe("现在");
  expect(zh(now - 5 * MINUTE)).toBe("5分钟前");
  expect(zh(now - 3 * 60 * MINUTE)).toBe("3小时前");
  expect(zh(at(2026, 10, 21, 9, 0))).toBe("昨天");
  expect(zh(at(2026, 10, 18, 23, 0))).toBe("4天前");
  expect(zh(at(2026, 10, 3, 12, 0))).toBe("11月3日");
});

test("a time ahead of the clock (another machine's) is now", () => {
  expect(relativeTime(now + 10 * MINUTE, now, "en-US")).toBe("now");
});

test("the whole time has the date and the clock", () => {
  const whole = fullTime(at(2026, 2, 4, 15, 3), "en-US");
  expect(whole).toContain("Mar 4, 2026");
  expect(whole).toContain("3:03");
});
