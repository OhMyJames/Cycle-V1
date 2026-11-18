import { expect, test } from "bun:test";
import { createThinkingStore, THINKING_KEY } from "../src/thinking.ts";

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
};

test("thinking is hidden until it is asked for", () => {
  expect(createThinkingStore(memory()).get()).toBe(false);
  expect(createThinkingStore(undefined).get()).toBe(false);
});

test("the choice is kept, and read back by the next run", () => {
  const storage = memory();
  const store = createThinkingStore(storage);
  store.set(true);
  expect(storage.data.get(THINKING_KEY)).toBe("true");
  expect(createThinkingStore(storage).get()).toBe(true);
});

test("a listener hears a change once, and not a choice that is the same", () => {
  const store = createThinkingStore(memory());
  let heard = 0;
  const stop = store.subscribe(() => {
    heard += 1;
  });
  store.set(true);
  store.set(true);
  expect(heard).toBe(1);
  stop();
  store.set(false);
  expect(heard).toBe(1);
});

test("storage that cannot be read or written leaves the choice to this run", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  const store = createThinkingStore(broken);
  expect(store.get()).toBe(false);
  store.set(true);
  expect(store.get()).toBe(true);
});
