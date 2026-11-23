import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SIZE,
  defaultBounds,
  fileFrameStore,
  keepFrame,
  MIN_SIZE,
  restoredFrame,
  type WindowFrame,
} from "../src/main/window-frame.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
/** A file in a temporary folder of its own, never the app's real data. */
const fileIn = async (content?: string) => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-window-frame-"));
  dirs.push(dir);
  const path = join(dir, "window-frame.json");
  if (content !== undefined) await writeFile(path, content);
  return path;
};

const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const monitor = { x: 1512, y: 0, width: 2560, height: 1415 };
const frame = (bounds: WindowFrame["bounds"], extra: Partial<WindowFrame> = {}): WindowFrame => ({
  bounds,
  maximized: false,
  fullScreen: false,
  ...extra,
});

test("a first start opens at the default size, centred on the main screen", () => {
  expect(restoredFrame(undefined, [laptop], laptop)).toEqual(
    frame({ x: 156, y: 85, ...DEFAULT_SIZE }),
  );
  // A screen smaller than the default: the window fits it.
  expect(defaultBounds({ x: 0, y: 0, width: 1000, height: 600 })).toEqual({
    x: 0,
    y: 0,
    width: 1000,
    height: 600,
  });
});

test("a saved frame on a connected screen comes back as it was", () => {
  const saved = frame({ x: 2000, y: 100, width: 1400, height: 900 });
  expect(restoredFrame(saved, [laptop, monitor], laptop)).toEqual(saved);
  expect(
    restoredFrame({ ...saved, maximized: true }, [laptop, monitor], laptop).maximized,
  ).toBeTrue();
  expect(
    restoredFrame({ ...saved, fullScreen: true }, [laptop, monitor], laptop).fullScreen,
  ).toBeTrue();
});

test("the monitor it was on is gone: the default frame on the main screen, never off-screen", () => {
  const saved = frame({ x: 2000, y: 100, width: 1400, height: 900 }, { maximized: true });
  expect(restoredFrame(saved, [laptop], laptop)).toEqual(
    frame({ x: 156, y: 85, ...DEFAULT_SIZE }, { maximized: true }),
  );
});

test("a frame partly off its screen is moved and shrunk into it, and not below the minimum size", () => {
  // Hanging off the right and the top, and taller than the screen.
  expect(
    restoredFrame(frame({ x: 1300, y: -200, width: 900, height: 2000 }), [laptop], laptop),
  ).toEqual(frame({ x: 612, y: 25, width: 900, height: 920 }));
  // Smaller than the app allows: it grows to the minimum.
  expect(
    restoredFrame(frame({ x: 100, y: 100, width: 300, height: 200 }), [laptop], laptop),
  ).toEqual(frame({ x: 100, y: 100, ...MIN_SIZE }));
});

test("what is not a frame is not taken", () => {
  for (const saved of [
    null,
    "x",
    [],
    { bounds: { x: 1, y: 2 } },
    { bounds: { x: 0, y: 0, width: 0, height: 5 } },
  ]) {
    expect(restoredFrame(saved, [laptop], laptop)).toEqual(frame(defaultBounds(laptop)));
  }
  expect(restoredFrame({ maximized: "yes" }, [laptop], laptop).maximized).toBeFalse();
});

test("the file: missing or broken is nothing, a saved frame reads back", async () => {
  expect(fileFrameStore(await fileIn()).load()).toBeUndefined();
  expect(fileFrameStore(await fileIn("{ not json")).load()).toBeUndefined();
  const path = await fileIn();
  const saved = frame({ x: 10, y: 20, width: 800, height: 600 }, { fullScreen: true });
  fileFrameStore(path).save(saved);
  expect(fileFrameStore(path).load()).toEqual(saved);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
});

test("a frame that cannot be written does not throw", async () => {
  const path = await fileIn();
  // A path no file can have.
  const blocked = fileFrameStore(join(path, "..", "..", "\0bad", "window-frame.json"));
  expect(() => blocked.save(frame(defaultBounds(laptop)))).not.toThrow();
});

test("moving and resizing save once, after they stop; closing saves at once", async () => {
  const saves: WindowFrame[] = [];
  let bounds = { x: 0, y: 0, width: 800, height: 600 };
  let open = true;
  const keeper = keepFrame({
    current: () => (open ? frame(bounds) : undefined),
    store: { load: () => undefined, save: (f) => saves.push(f) },
    delayMs: 20,
  });
  for (let i = 0; i < 5; i++) {
    bounds = { ...bounds, x: i * 10 };
    keeper.changed();
  }
  expect(saves).toEqual([]);
  await Bun.sleep(60);
  expect(saves).toEqual([frame({ x: 40, y: 0, width: 800, height: 600 })]);

  bounds = { ...bounds, width: 1000 };
  keeper.changed();
  keeper.closing();
  expect(saves.at(-1)).toEqual(frame({ x: 40, y: 0, width: 1000, height: 600 }));
  // The waiting save was the one closing did: nothing more comes later.
  open = false;
  await Bun.sleep(60);
  expect(saves).toHaveLength(2);
});
