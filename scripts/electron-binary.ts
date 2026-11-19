// Where Electron's executable is, for the tests that run it. It is a different file on each system: the dist
// folder holds `electron` on Linux, and an app bundle on macOS.
import { join } from "node:path";

const RELATIVE: Record<string, string> = {
  darwin: "Electron.app/Contents/MacOS/Electron",
  win32: "electron.exe",
};

/** The path of Electron's executable in bun's install folder (`node_modules/.bun`), or undefined when it is not installed. */
export const electronBinary = (
  bunModules: string,
  platform: string = process.platform,
): string | undefined => {
  const relative = RELATIVE[platform] ?? "electron";
  const found = Array.from(
    new Bun.Glob(`electron@*/node_modules/electron/dist/${relative}`).scanSync(bunModules),
  );
  return found[0] === undefined ? undefined : join(bunModules, found[0]);
};
