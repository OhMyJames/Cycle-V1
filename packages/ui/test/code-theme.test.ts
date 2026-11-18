import { expect, test } from "bun:test";
import {
  CODE_THEME_KEY,
  CODE_THEMES,
  createCodeThemeStore,
  DEFAULT_CODE_THEME,
  themesOf,
} from "../src/code-theme.ts";

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

test("starts on the default, or on what was saved", () => {
  expect(createCodeThemeStore(memory()).get()).toBe(DEFAULT_CODE_THEME);
  expect(createCodeThemeStore(memory({ [CODE_THEME_KEY]: "catppuccin" })).get()).toBe("catppuccin");
  expect(createCodeThemeStore(undefined).get()).toBe(DEFAULT_CODE_THEME);
});

test("a saved value that is not an option is ignored, not trusted", () => {
  expect(createCodeThemeStore(memory({ [CODE_THEME_KEY]: "<script>" })).get()).toBe(
    DEFAULT_CODE_THEME,
  );
});

test("a choice is saved, and listeners hear of it once; choosing the same again says nothing", () => {
  const storage = memory();
  const store = createCodeThemeStore(storage);
  let heard = 0;
  const stop = store.subscribe(() => heard++);
  store.set("one");
  store.set("one");
  expect(store.get()).toBe("one");
  expect(storage.data.get(CODE_THEME_KEY)).toBe("one");
  expect(heard).toBe(1);
  stop();
  store.set("vscode");
  expect(heard).toBe(1);
});

test("storage that throws does not break choosing", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  const store = createCodeThemeStore(broken);
  expect(store.get()).toBe(DEFAULT_CODE_THEME);
  store.set("one");
  expect(store.get()).toBe("one");
});

test("every option has a light and a dark theme", () => {
  expect(CODE_THEMES).toHaveLength(5);
  for (const theme of CODE_THEMES) expect(themesOf(theme.id)).toHaveLength(2);
});
