import { createContext, type ReactNode, useContext } from "react";
import { createTranslator, SOURCE_LOCALE, type Translator } from "../i18n.ts";
import { enUS } from "../messages/en-US.ts";

/** What is used when nothing is provided: the source language. */
const fallback = createTranslator(SOURCE_LOCALE, enUS);
const I18nContext = createContext<Translator>(fallback);

/** Gives the interface below it a language: `createTranslator(locale, messages, enUS)`. */
export function I18nProvider({
  translator,
  children,
}: {
  translator: Translator;
  children: ReactNode;
}) {
  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

export const useI18n = (): Translator => useContext(I18nContext);
