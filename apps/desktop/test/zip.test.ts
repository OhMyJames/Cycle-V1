import { expect, test } from "bun:test";
import { parseDirectory, parseEnd, parseLocal } from "../src/shared/zip.ts";
import { makeZip } from "./zip-fixture.ts";

const zip = makeZip({ "a.txt": "hello", "dir/b.txt": "world world world" });

test("the end record and the directory say where each file is and how big", () => {
  const end = parseEnd(zip);
  expect(end.entries).toBe(2);
  const entries = parseDirectory(
    zip.subarray(end.directoryOffset, end.directoryOffset + end.directorySize),
    end.entries,
  );
  expect([...entries.keys()]).toEqual(["Cycle.app/a.txt", "Cycle.app/dir/b.txt"]);
  const b = entries.get("Cycle.app/dir/b.txt");
  expect(b?.size).toBe(17);
  const local = parseLocal(zip.subarray(b?.offset ?? 0, (b?.offset ?? 0) + 30));
  expect(local.nameLength).toBe(b?.nameLength ?? -1);
});

test("an end record is found after a comment, and not in bytes that only look like one", () => {
  const comment = new TextEncoder().encode("PK\x05\x06 not the end");
  const withComment = new Uint8Array(zip.length + comment.length);
  withComment.set(zip);
  withComment.set(comment, zip.length);
  new DataView(withComment.buffer).setUint16(zip.length - 2, comment.length, true);
  expect(parseEnd(withComment).entries).toBe(2);
  expect(() => parseEnd(new Uint8Array(100))).toThrow(/no end record/);
});

test("what the updater cannot read piecewise is refused, not misread", () => {
  const copy = new Uint8Array(zip);
  // zip64 marker in the end record
  new DataView(copy.buffer).setUint32(copy.length - 6, 0xffffffff, true);
  expect(() => parseEnd(copy)).toThrow(/zip64/);
  const end = parseEnd(zip);
  const directory = new Uint8Array(
    zip.subarray(end.directoryOffset, end.directoryOffset + end.directorySize),
  );
  directory[8] = 1; // the first file is encrypted
  expect(() => parseDirectory(directory, end.entries)).toThrow(/encrypted/);
  expect(() => parseDirectory(directory.subarray(0, 20), end.entries)).toThrow(/damaged/);
  expect(() => parseLocal(new Uint8Array(30))).toThrow(/no file/);
});
