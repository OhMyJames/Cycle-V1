// Words the interface says, kept apart from the code that says them, so that a language can be added without touching it.
// en-US is the source language: every key has its text there, and a language that lacks a key falls back to it.
// No React and no DOM: the Electron main process may use it too. DESIGN.md section 14 says how strings are written.

/** A plain text, or one text per plural form (Intl.PluralRules names them: one, other, few, many, ...). */
export type Message = string | ({ other: string } & Partial<Record<Intl.LDMLPluralRule, string>>);
export type Messages = Readonly<Record<string, Message>>;
export type Params = Readonly<Record<string, string | number>>;

export const SOURCE_LOCALE = "en-US";

/** `{name}` is replaced by the parameter of that name. Nothing else is interpreted: no markup, no code. */
const fill = (text: string, params: Params | undefined, numbers: Intl.NumberFormat): string =>
  text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params?.[name];
    if (value === undefined) return whole;
    return typeof value === "number" ? numbers.format(value) : value;
  });

export type Translator = {
  readonly locale: string;
  /** The text of a key. For a plural message give `count`. A key nobody has is returned as it is: visible, not blank. */
  t: (key: string, params?: Params & { count?: number }) => string;
  /** A number as this locale writes it. */
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** Items joined as this locale writes a list: "a, b and c". */
  list: (items: readonly string[]) => string;
  /** A date and time as this locale writes it. */
  date: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
};

/** A translator for `locale`: its own messages first, then the source language's. */
export const createTranslator = (
  locale: string,
  messages: Messages,
  source: Messages = messages,
): Translator => {
  const numbers = new Intl.NumberFormat(locale);
  const plural = new Intl.PluralRules(locale);
  const t: Translator["t"] = (key, params) => {
    const message = messages[key] ?? source[key];
    if (message === undefined) return key;
    if (typeof message === "string") return fill(message, params, numbers);
    const form = params?.count === undefined ? "other" : plural.select(params.count);
    return fill(message[form] ?? message.other, params, numbers);
  };
  return {
    locale,
    t,
    number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    list: (items) =>
      new Intl.ListFormat(locale, { type: "conjunction", style: "long" }).format(items),
    date: (value, options) => new Intl.DateTimeFormat(locale, options).format(value),
  };
};
