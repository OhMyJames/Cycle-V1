import { expect, test } from "bun:test";
import { createTranslator, SOURCE_LOCALE } from "../src/i18n.ts";
import { fullTime, relativeTime } from "../src/message-time.ts";
import { enUS } from "../src/messages/en-US.ts";
import { zhCN } from "../src/messages/zh-CN.ts";

const en = createTranslator(SOURCE_LOCALE, enUS);
const zh = createTranslator("zh-CN", zhCN, enUS);
const now = new Date(2026, 10, 22, 15, 0).getTime();
const MIN = 60_000;

test("a time reads as how long ago, in words, then as a date", () => {
  expect(relativeTime(en, now - 10_000, now)).toBe("Just now");
  // A daemon whose clock runs a little fast is not "in 1 minute".
  expect(relativeTime(en, now + 20_000, now)).toBe("Just now");
  expect(relativeTime(en, now - 3 * MIN, now)).toBe("3 minutes ago");
  expect(relativeTime(en, now - 2 * 60 * MIN, now)).toBe("2 hours ago");
  expect(relativeTime(en, now - 26 * 60 * MIN, now)).toBe("yesterday");
  expect(relativeTime(en, now - 3 * 24 * 60 * MIN, now)).toBe("3 days ago");
  expect(relativeTime(en, new Date(2026, 9, 2, 9, 0).getTime(), now)).toBe("Oct 2");
  expect(relativeTime(en, new Date(2025, 9, 2, 9, 0).getTime(), now)).toBe("Oct 2, 2025");
});

test("in Chinese the words are Chinese", () => {
  expect(relativeTime(zh, now - 10_000, now)).toBe("刚刚");
  expect(relativeTime(zh, now - 3 * MIN, now)).toBe("3分钟前");
  expect(relativeTime(zh, now - 26 * 60 * MIN, now)).toBe("昨天");
});

test("the full time has the date and the clock", () => {
  const full = fullTime(en, new Date(2026, 10, 22, 15, 4).getTime());
  expect(full).toContain("November 22, 2026");
  expect(full).toContain("3:04");
});
