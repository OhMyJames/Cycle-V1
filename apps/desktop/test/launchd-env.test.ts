import { expect, test } from "bun:test";
import { withLaunchdEnv } from "./launchd-env.ts";

/** A launchd that keeps its variables in a map. */
const fakeLaunchd = (initial: Record<string, string>) => {
  const env = new Map(Object.entries(initial));
  const calls: string[][] = [];
  const launchctl = (args: string[]): string => {
    calls.push(args);
    const [verb, key = "", value = ""] = args;
    if (verb === "setenv") env.set(key, value);
    else if (verb === "unsetenv") env.delete(key);
    else if (verb === "getenv") return env.get(key) ?? "";
    return "";
  };
  return { env, calls, launchctl };
};

test("during the body the variables are set; afterwards they are as they were", async () => {
  const d = fakeLaunchd({ CYCLE_HOME: "/the/owners", OTHER: "kept" });
  const seen = await withLaunchdEnv(
    d.launchctl,
    { CYCLE_HOME: "/tmp/test", CYCLE_UPDATE_URL: "http://127.0.0.1:1" },
    async () => Object.fromEntries(d.env),
  );
  expect(seen).toEqual({
    CYCLE_HOME: "/tmp/test",
    OTHER: "kept",
    CYCLE_UPDATE_URL: "http://127.0.0.1:1",
  });
  expect(Object.fromEntries(d.env)).toEqual({ CYCLE_HOME: "/the/owners", OTHER: "kept" });
});

test("it is put back when the body fails, and the failure is the body's", async () => {
  const d = fakeLaunchd({ CYCLE_HOME: "/the/owners" });
  await expect(
    withLaunchdEnv(d.launchctl, { CYCLE_HOME: "/tmp/test" }, async () => {
      throw new Error("the test failed");
    }),
  ).rejects.toThrow("the test failed");
  expect(d.env.get("CYCLE_HOME")).toBe("/the/owners");
});

test("a variable that was not set is removed, and one that cannot be restored does not hide the result", async () => {
  const d = fakeLaunchd({});
  expect(await withLaunchdEnv(d.launchctl, { CYCLE_HOME: "/tmp/test" }, async () => 7)).toBe(7);
  expect(d.env.has("CYCLE_HOME")).toBe(false);
  const broken = (args: string[]): string => {
    if (args[0] === "unsetenv") throw new Error("launchctl failed");
    return d.launchctl(args);
  };
  expect(await withLaunchdEnv(broken, { CYCLE_HOME: "/tmp/test" }, async () => 8)).toBe(8);
});

test("if what was there cannot be read, nothing is set: it could not be put back", async () => {
  const d = fakeLaunchd({ CYCLE_HOME: "/the/owners" });
  const unreadable = (args: string[]): string => {
    if (args[0] === "getenv") throw new Error("launchctl failed");
    return d.launchctl(args);
  };
  await expect(
    withLaunchdEnv(unreadable, { CYCLE_HOME: "/tmp/test" }, async () => 1),
  ).rejects.toThrow("launchctl failed");
  expect(d.calls.some((call) => call[0] === "setenv" || call[0] === "unsetenv")).toBe(false);
  expect(d.env.get("CYCLE_HOME")).toBe("/the/owners");
});
