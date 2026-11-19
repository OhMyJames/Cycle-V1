import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { electronBinary } from "./electron-binary.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-electron-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const install = async (relative: string) => {
  const path = join(dir, "electron@41.0.0", "node_modules", "electron", "dist", relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
  return path;
};

test("on Linux it is dist/electron", async () => {
  const path = await install("electron");
  expect(electronBinary(dir, "linux")).toBe(path);
});

test("on macOS it is inside the app bundle", async () => {
  const path = await install("Electron.app/Contents/MacOS/Electron");
  expect(electronBinary(dir, "darwin")).toBe(path);
  // The Linux name is not what macOS has: nothing to find there.
  expect(electronBinary(dir, "linux")).toBeUndefined();
});

test("with no Electron installed it is undefined", () => {
  expect(electronBinary(dir, "darwin")).toBeUndefined();
});
