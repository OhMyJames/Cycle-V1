import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PREFERENCES,
  filePreferencesStore,
  memoryPreferencesStore,
  startPreferences,
} from "../src/main/preferences.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const fileIn = async (content?: string) => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-preferences-"));
  dirs.push(dir);
  const path = join(dir, "preferences.json");
  if (content !== undefined) await writeFile(path, content);
  return path;
};

test("no file, or one that is not JSON: the app follows the system", async () => {
  expect(await filePreferencesStore(await fileIn()).load()).toEqual(DEFAULT_PREFERENCES);
  expect(await filePreferencesStore(await fileIn("{ not json")).load()).toEqual(
    DEFAULT_PREFERENCES,
  );
});

test("a choice is still there after the app starts again", async () => {
  const path = await fileIn();
  const applied: string[] = [];
  const first = await startPreferences({
    store: filePreferencesStore(path),
    systemLanguage: () => "en-GB",
    applyTheme: (theme) => applied.push(theme),
  });
  expect(first.state()).toEqual({ theme: "system", language: "system", systemLanguage: "en-GB" });
  expect(await first.set({ theme: "dark" })).toMatchObject({ theme: "dark", language: "system" });
  expect(await first.set({ language: "zh-CN" })).toMatchObject({
    theme: "dark",
    language: "zh-CN",
  });
  // The start applies what was read; a change of theme applies it; a change of language leaves the theme alone.
  expect(applied).toEqual(["system", "dark"]);

  const again: string[] = [];
  const second = await startPreferences({
    store: filePreferencesStore(path),
    systemLanguage: () => "en-GB",
    applyTheme: (theme) => again.push(theme),
  });
  expect(second.state()).toMatchObject({ theme: "dark", language: "zh-CN" });
  // Before a window is made: the first thing drawn is already dark.
  expect(again).toEqual(["dark"]);
});

test("a value that is not one of the choices is not taken, from the file or from the page", async () => {
  const path = await fileIn(JSON.stringify({ theme: "sepia", language: "tlh", later: { a: 1 } }));
  const store = filePreferencesStore(path);
  expect(await store.load()).toEqual(DEFAULT_PREFERENCES);
  const control = await startPreferences({
    store,
    systemLanguage: () => "en-US",
    applyTheme: () => {},
  });
  expect(await control.set({ theme: "<script>", language: 7 })).toMatchObject(DEFAULT_PREFERENCES);
  expect(await control.set("dark")).toMatchObject(DEFAULT_PREFERENCES);
  await control.set({ theme: "light" });
  // What a newer version kept in the file is written back as it was.
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    later: { a: 1 },
    theme: "light",
    language: "system",
  });
});

test("a change is counted by its word, a choice that changes nothing is not, and one that cannot be kept changes nothing", async () => {
  const events: unknown[] = [];
  const applied: string[] = [];
  let fail = false;
  const kept = memoryPreferencesStore();
  const control = await startPreferences({
    store: {
      load: kept.load,
      save: async (preferences) => {
        if (fail) throw new Error("disk full");
        await kept.save(preferences);
      },
    },
    systemLanguage: () => "zh-Hans-CN",
    applyTheme: (theme) => applied.push(theme),
    track: (name, props) => events.push([name, props]),
  });
  await control.set({ theme: "light" });
  await control.set({ theme: "light" });
  await control.set({ language: "en-US" });
  expect(events).toEqual([
    ["theme_changed", { theme: "light" }],
    ["language_changed", { language: "en-US" }],
  ]);
  fail = true;
  expect(control.set({ theme: "dark" })).rejects.toThrow("disk full");
  await Promise.resolve();
  expect(control.state()).toMatchObject({ theme: "light", language: "en-US" });
  expect(applied).toEqual(["system", "light"]);
  expect(events).toHaveLength(2);
});
