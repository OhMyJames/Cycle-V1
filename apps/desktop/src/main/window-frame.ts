// Where the window was and how big, so the app opens again as the person left it: the frame, and whether it was
// maximized or in full screen. Kept in a file of the app's own data (`window-frame.json`), apart from the preferences:
// a file that cannot be read costs a frame, nothing else. Nothing here knows Electron; app.ts hands in the window's
// events and the screens. Reference: cycle_v2's `window-frame.ts`.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Rectangle = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** What is kept. `bounds` is the normal frame, so a window maximized or in full screen comes back that size after. */
export type WindowFrame = {
  readonly bounds: Rectangle;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
};

/** The frame of a first start, and of one whose screen is gone. */
export const DEFAULT_SIZE = { width: 1200, height: 800 } as const;
/** Below this the sidebar and the conversation cannot both be used (DESIGN.md section 9). */
export const MIN_SIZE = { width: 720, height: 480 } as const;
/** How much of the window must be on a screen, across and down, for it to come back there. */
const GRAB = 100;
/** A drag or a resize sends many events; only where it ends is worth writing. */
export const SAVE_DELAY_MS = 500;

const isRectangle = (value: unknown): value is Rectangle =>
  typeof value === "object" &&
  value !== null &&
  ["x", "y", "width", "height"].every((key) => Number.isFinite(Reflect.get(value, key))) &&
  Reflect.get(value, "width") > 0 &&
  Reflect.get(value, "height") > 0;

/** The default size centred in `workArea`, shrunk to it when the screen is smaller. */
export const defaultBounds = (workArea: Rectangle): Rectangle => {
  const width = Math.min(DEFAULT_SIZE.width, Math.max(workArea.width, 0));
  const height = Math.min(DEFAULT_SIZE.height, Math.max(workArea.height, 0));
  if (width <= 0 || height <= 0) return { x: 0, y: 0, ...DEFAULT_SIZE };
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
};

/** `value` moved, as little as it takes, into `[start, start + room]`. */
const clamp = (value: number, start: number, room: number): number =>
  Math.round(Math.min(Math.max(value, start), start + Math.max(room, 0)));

/** How far a span from `start` overlaps one from `areaStart`, negative when they are apart. */
const overlap = (start: number, size: number, areaStart: number, areaSize: number): number =>
  Math.min(start + size, areaStart + areaSize) - Math.max(start, areaStart);

/**
 * The frame to open with. The saved one, if a screen connected now shows enough of it, moved and shrunk into that
 * screen's usable area (never smaller than the minimum size unless the screen is), so the title bar can always be
 * reached. Otherwise (nothing saved, a file that is not a frame, the monitor it was on is gone) the default size,
 * centred on `primary`. Maximized and full screen are kept either way: they are how the person likes the window.
 */
export const restoredFrame = (
  saved: unknown,
  workAreas: readonly Rectangle[],
  primary: Rectangle,
): WindowFrame => {
  const value = typeof saved === "object" && saved !== null ? saved : {};
  const maximized = Reflect.get(value, "maximized") === true;
  const fullScreen = Reflect.get(value, "fullScreen") === true;
  const bounds = Reflect.get(value, "bounds");
  const area = isRectangle(bounds)
    ? workAreas.find(
        (candidate) =>
          overlap(bounds.x, bounds.width, candidate.x, candidate.width) >= GRAB &&
          overlap(bounds.y, bounds.height, candidate.y, candidate.height) >= GRAB,
      )
    : undefined;
  if (!isRectangle(bounds) || area === undefined) {
    return { bounds: defaultBounds(primary), maximized, fullScreen };
  }
  const width = Math.round(Math.min(Math.max(bounds.width, MIN_SIZE.width), area.width));
  const height = Math.round(Math.min(Math.max(bounds.height, MIN_SIZE.height), area.height));
  return {
    bounds: {
      x: clamp(bounds.x, area.x, area.width - width),
      y: clamp(bounds.y, area.y, area.height - height),
      width,
      height,
    },
    maximized,
    fullScreen,
  };
};

export type FrameStore = {
  /** What was saved, unchecked: `restoredFrame` decides what of it can be used. */
  load(): unknown;
  save(frame: WindowFrame): void;
};

/**
 * The frame in a JSON file, written whole and renamed into place. Synchronous: it is read once before the window is
 * made, and written last as the window closes, when there is no later to wait for. A file that cannot be read or
 * written leaves the next start at the default frame.
 */
export const fileFrameStore = (path: string): FrameStore => ({
  load() {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  },
  save(frame) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(frame, null, 2)}\n`);
      renameSync(temporary, path);
    } catch {
      // Not kept: the next start opens at the default frame.
    }
  },
});

/**
 * Saves the window's frame a moment after it stops changing, and at once when it closes if a save is still waiting.
 * `current` reads the window; it gives nothing once the window is gone.
 */
export const keepFrame = (options: {
  current: () => WindowFrame | undefined;
  store: FrameStore;
  delayMs?: number;
}): { changed: () => void; closing: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    const frame = options.current();
    if (frame !== undefined) options.store.save(frame);
  };
  return {
    changed() {
      clearTimeout(timer);
      timer = setTimeout(save, options.delayMs ?? SAVE_DELAY_MS);
    },
    closing() {
      save();
    },
  };
};
