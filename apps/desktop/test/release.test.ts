import { expect, test } from "bun:test";
import { archiveName, isNewer, manifestFor, parseManifest } from "../src/shared/release.ts";

const hash = "a".repeat(64);

test("a manifest the release script wrote is one the updater accepts", () => {
  const manifest = manifestFor(
    { version: "0.1.0", platform: "darwin", arch: "arm64" },
    { sha256: hash, size: 5 },
  );
  expect(manifest.file).toBe("Cycle-0.1.0-darwin-arm64.zip");
  expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
});

test("a manifest that points at another file, or is not whole, is refused", () => {
  const ok = manifestFor(
    { version: "0.1.0", platform: "darwin", arch: "arm64" },
    { sha256: hash, size: 5 },
  );
  expect(() => parseManifest(JSON.stringify({ ...ok, file: "evil.zip" }))).toThrow(
    /unexpected archive/,
  );
  expect(() => parseManifest(JSON.stringify({ ...ok, sha256: "xyz" }))).toThrow(/SHA-256/);
  expect(() => parseManifest(JSON.stringify({ ...ok, size: 0 }))).toThrow(/size/);
  expect(() => parseManifest(JSON.stringify({ ...ok, version: "1.0" }))).toThrow(/version/);
  expect(() => parseManifest("not json")).toThrow(/not JSON/);
  expect(archiveName("0.1.0", "darwin", "arm64")).toBe("Cycle-0.1.0-darwin-arm64.zip");
});

test("versions compare as numbers, and anything that is not major.minor.patch is never newer", () => {
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("1.0.0-beta", "0.1.0")).toBe(false);
});
