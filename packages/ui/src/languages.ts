// The languages the interface has, and which one a choice comes to. No React and no DOM: the Electron main process
// uses it too, for what it says itself (a notification). en-US is the source (decision 0012): a language that lacks a
// key falls back to it.
import type { LanguageChoice } from "./api.ts";
import { createTranslator, type Messages, SOURCE_LOCALE, type Translator } from "./i18n.ts";
import { enUS } from "./messages/en-US.ts";
import { zhCN } from "./messages/zh-CN.ts";

export type LanguageId = Exclude<LanguageChoice, "system">;

/** Each language, named in its own words: a person who cannot read the current one still finds theirs. */
export const LANGUAGES: readonly { id: LanguageId; name: string; messages: Messages }[] = [
  { id: "en-US", name: "English", messages: enUS },
  { id: "zh-CN", name: "简体中文", messages: zhCN },
];

/**
 * The language the system's locale comes to. Chinese written in simplified characters is zh-CN; Chinese written in
 * traditional ones (Taiwan, Hong Kong, Macau, or `Hant`) has no catalog yet and reads the source language, as every
 * other locale does.
 */
export const languageOfSystem = (locale: string): LanguageId => {
  const [language, ...rest] = locale.toLowerCase().split(/[-_]/);
  if (language !== "zh") return SOURCE_LOCALE;
  const traditional = rest.some((part) => ["hant", "tw", "hk", "mo"].includes(part));
  return traditional ? SOURCE_LOCALE : "zh-CN";
};

export const resolveLanguage = (choice: LanguageChoice, systemLocale: string): LanguageId =>
  choice === "system" ? languageOfSystem(systemLocale) : choice;

const translators = new Map<LanguageId, Translator>();

/** The translator of a language: its own messages first, then the source language's. One per language. */
export const translatorFor = (id: LanguageId): Translator => {
  const known = translators.get(id);
  if (known !== undefined) return known;
  const messages = LANGUAGES.find((l) => l.id === id)?.messages ?? enUS;
  const made = createTranslator(id, messages, enUS);
  translators.set(id, made);
  return made;
};
