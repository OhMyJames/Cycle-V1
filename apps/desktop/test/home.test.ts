import { expect, test } from "bun:test";
import { DEV_HOME, localHome } from "../src/main/home.ts";

test("an installed app leaves the data directory to the daemon's default", () => {
  expect(localHome({ packaged: true, env: {}, home: "/home/x" })).toBeUndefined();
});

test("a run from source has a data directory of its own, never the installed app's", () => {
  const dev = localHome({ packaged: false, env: {}, home: "/home/x" });
  expect(dev).toBe(`/home/x/${DEV_HOME}`);
  expect(dev).not.toBe("/home/x/.cycle");
});

test("CYCLE_HOME decides for both, and an empty one is not a choice", () => {
  expect(localHome({ packaged: true, env: { CYCLE_HOME: "/data/a" }, home: "/home/x" })).toBe(
    "/data/a",
  );
  expect(localHome({ packaged: false, env: { CYCLE_HOME: "/data/a" }, home: "/home/x" })).toBe(
    "/data/a",
  );
  expect(localHome({ packaged: false, env: { CYCLE_HOME: "" }, home: "/home/x" })).toBe(
    `/home/x/${DEV_HOME}`,
  );
});
