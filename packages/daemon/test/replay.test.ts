import { afterEach, beforeEach, expect, test } from "bun:test";
import { attach, JsonlLogStore, type LogRecord } from "../src/index.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(() => dispose());

const open = () => new JsonlLogStore({ dir }).open("s1");
const seqs = (records: LogRecord[]) => records.map((r) => r.seq);

test("replays everything after a point, then the live records", async () => {
  const log = await open();
  for (let i = 0; i < 5; i++) await log.append({ kind: "update", data: i });
  const got: LogRecord[] = [];
  const { replayedTo, detach } = await attach(log, 2, (r) => {
    got.push(r);
  });
  expect(replayedTo).toBe(5);
  expect(seqs(got)).toEqual([3, 4, 5]);
  await log.append({ kind: "update", data: 5 });
  expect(seqs(got)).toEqual([3, 4, 5, 6]);
  detach();
  await log.append({ kind: "update", data: 6 });
  expect(seqs(got)).toEqual([3, 4, 5, 6]);
  await log.close();
});

test("loses and repeats nothing when records are appended during the replay", async () => {
  const log = await open();
  for (let i = 0; i < 20; i++) await log.append({ kind: "update", data: i });
  const got: number[] = [];
  let appending: Promise<unknown> = Promise.resolve();
  let live = 0;
  const attached = attach(log, 0, async (r) => {
    got.push(r.seq);
    // A slow client: while it takes the first records, the session keeps going.
    if (live++ < 10) appending = appending.then(() => log.append({ kind: "update", data: "live" }));
    await Bun.sleep(1);
  });
  await attached;
  await appending;
  await Bun.sleep(20);
  const final = log.lastSeq();
  expect(got).toEqual(Array.from({ length: final }, (_, i) => i + 1).slice(0, got.length));
  expect(new Set(got).size).toBe(got.length);
  expect(got.at(-1)).toBe(final);
  await log.close();
});

test("an empty history replays to nothing and then goes live", async () => {
  const log = await open();
  const got: LogRecord[] = [];
  await attach(log, 0, (r) => {
    got.push(r);
  });
  await log.append({ kind: "update", data: 1 });
  expect(seqs(got)).toEqual([1]);
  await log.close();
});

test("refuses a point past the end of the history", async () => {
  const log = await open();
  await log.append({ kind: "update", data: 1 });
  await expect(attach(log, 2, () => {})).rejects.toMatchObject({ code: -32602 });
  await expect(attach(log, -1, () => {})).rejects.toMatchObject({ code: -32602 });
  await log.close();
});

test("a client that fails while being sent the history stops receiving", async () => {
  const log = await open();
  await log.append({ kind: "update", data: 1 });
  await expect(
    attach(log, 0, () => {
      throw new Error("client gone");
    }),
  ).rejects.toThrow("client gone");
  await log.append({ kind: "update", data: 2 });
  await log.close();
});
