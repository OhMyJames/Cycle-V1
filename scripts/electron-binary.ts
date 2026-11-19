// Where Electron's executable is, for the tests that run it. It is a different file on each system: the dist
// folder holds `electron` on Linux, and an app bundle on macOS.
import { join } from "node:path";

/** Linux is `electron`; macOS has it inside the app bundle. Other systems are not ones these tests run on. */
const MAC = "Electron.app/Contents/MacOS/Electron";

/** The path of Electron's executable in bun's install folder (`node_modules/.bun`), or undefined when it is not installed. */
export const electronBinary = (
  bunModules: string,
  platform: string = process.platform,
): string | undefined => {
  const relative = platform === "darwin" ? MAC : "electron";
  // The same one on every machine when there are several versions: the last by name.
  const found = Array.from(
    new Bun.Glob(`electron@*/node_modules/electron/dist/${relative}`).scanSync(bunModules),
  ).sort();
  const last = found.at(-1);
  return last === undefined ? undefined : join(bunModules, last);
};
