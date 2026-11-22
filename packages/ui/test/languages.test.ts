import { expect, test } from "bun:test";
import type { Message } from "../src/i18n.ts";
import { LANGUAGES, languageOfSystem, resolveLanguage, translatorFor } from "../src/languages.ts";
import { enUS } from "../src/messages/en-US.ts";
import { zhCN } from "../src/messages/zh-CN.ts";

test("the system's language is followed when the interface has it, and is the source language when it has not", () => {
  expect(languageOfSystem("zh-CN")).toBe("zh-CN");
  expect(languageOfSystem("zh")).toBe("zh-CN");
  expect(languageOfSystem("zh-Hans-SG")).toBe("zh-CN");
  expect(languageOfSystem("zh_CN")).toBe("zh-CN");
  // Traditional Chinese has no catalog: not shown simplified characters it did not ask for.
  expect(languageOfSystem("zh-TW")).toBe("en-US");
  expect(languageOfSystem("zh-Hant-HK")).toBe("en-US");
  expect(languageOfSystem("en-GB")).toBe("en-US");
  expect(languageOfSystem("de-DE")).toBe("en-US");
  expect(languageOfSystem("")).toBe("en-US");
});

test("a chosen language holds whatever the system's is", () => {
  expect(resolveLanguage("zh-CN", "en-US")).toBe("zh-CN");
  expect(resolveLanguage("en-US", "zh-CN")).toBe("en-US");
  expect(resolveLanguage("system", "zh-CN")).toBe("zh-CN");
});

test("each language says its own name, and its translator writes numbers and words its way", () => {
  expect(LANGUAGES.map((l) => l.name)).toEqual(["English", "简体中文"]);
  const zh = translatorFor("zh-CN");
  expect(zh.locale).toBe("zh-CN");
  expect(zh.t("sessions.showAll", { count: 3 })).toBe("再显示 3 个会话");
  expect(zh.t("settings.title")).toBe("设置");
  expect(translatorFor("en-US").t("sessions.showAll", { count: 1 })).toBe("Show 1 more session");
  expect(translatorFor("zh-CN")).toBe(zh);
});

const placeholders = (message: Message): string[] => {
  const texts = typeof message === "string" ? [message] : Object.values(message);
  return [...new Set(texts.flatMap((text) => text.match(/\{\w+\}/g) ?? []))].sort();
};

test("the Chinese catalog has every key of the source, with the same placeholders and nothing left empty", () => {
  expect(Object.keys(zhCN).sort()).toEqual(Object.keys(enUS).sort());
  const wrong: string[] = [];
  for (const [key, source] of Object.entries(enUS)) {
    const translated = (zhCN as Record<string, Message>)[key];
    if (translated === undefined) continue;
    if (typeof translated === "string" ? translated.trim() === "" : translated.other.trim() === "")
      wrong.push(`${key}: empty`);
    if (placeholders(translated).join() !== placeholders(source).join())
      wrong.push(`${key}: ${placeholders(translated)} is not ${placeholders(source)}`);
  }
  expect(wrong).toEqual([]);
});
