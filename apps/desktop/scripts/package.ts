// Assembles the app from Electron's own distribution and Cycle's files. No packager: the app is a
// copy of Electron with its default app replaced by a folder, `app`, which is where Electron looks
// when there is no asar.
//
//   Cycle.app/Contents/Resources/app/{package.json, build.json, dist/, bin/cycle, bin/claude}
//
// On macOS the copy is a bundle with its Info.plist changed and an ad hoc signature, so that it runs
// at all on Apple silicon; a release then signs it with a Developer ID and notarizes it (sign.ts).
// On Linux the same files make a folder. That is what the tests launch.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  APP_NAME,
  BUILD_FILE,
  BUNDLE_ID,
  CLAUDE_BIN,
  DAEMON_BIN,
  DIST_DIR,
  MAC_BUNDLE,
  MAIN,
} from "../src/main/layout.ts";
import { removePlistDict, setPlistString } from "./plist.ts";

const DESKTOP = new URL("..", import.meta.url).pathname;
const ROOT = join(DESKTOP, "../..");
/** Where packaged apps go: apps/desktop/build. */
export const BUILD_DIR = join(DESKTOP, "build");

const run = (command: string[], cwd = ROOT) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (!result.success) throw new Error(`${command.join(" ")} failed`);
};

const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/** The daemon is compiled with the Bun running this, so it must be the one the repository pins. */
const requirePinnedBun = () => {
  const pinned = String(json(join(ROOT, "package.json")).packageManager);
  if (`bun@${Bun.version}` !== pinned) {
    throw new Error(`This is Bun ${Bun.version}; the app must carry the pinned ${pinned}.`);
  }
};

/** Electron's distribution: its installer unpacks it from its cache, or downloads it, on first use. */
const electronDist = (): { dist: string; version: string } => {
  const packageDir = dirname(Bun.resolveSync("electron/package.json", DESKTOP));
  const dist = join(packageDir, "dist");
  if (!existsSync(join(dist, "version"))) run([process.execPath, "install.js"], packageDir);
  if (!existsSync(join(dist, "version"))) throw new Error(`Electron's installer left no ${dist}`);
  return { dist, version: readFileSync(join(dist, "version"), "utf8").trim().replace(/^v/, "") };
};

/** A copy that keeps symbolic links and modes. On APFS it is a clone, which takes no space. */
const copyTree = (from: string, to: string) =>
  run(process.platform === "darwin" ? ["/bin/cp", "-cR", from, to] : ["/bin/cp", "-a", from, to]);

export type Packaged = { app: string; appDir: string; executable: string; version: string };

export const packageApp = (outDir = BUILD_DIR): Packaged => {
  const { platform, arch } = process;
  if (platform !== "darwin" && platform !== "linux")
    throw new Error(`Packaging is for macOS and Linux, not ${platform}.`);
  requirePinnedBun();
  const version = String(json(join(DESKTOP, "package.json")).version);
  const electron = electronDist();

  // The main process, preload and page; and the daemon with Claude beside it, for this platform.
  run([process.execPath, "scripts/build.ts"], DESKTOP);
  run([process.execPath, "scripts/build.ts", "--no-tarball"], join(ROOT, "apps/daemon"));
  const daemonDir = join(ROOT, "apps/daemon/dist", `cycle-${platform}-${arch}`);

  mkdirSync(outDir, { recursive: true });
  const staging = join(outDir, ".app-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, dirname(DAEMON_BIN)), { recursive: true });
  cpSync(join(DESKTOP, "dist"), join(staging, DIST_DIR), { recursive: true });
  cpSync(join(daemonDir, "cycle"), join(staging, DAEMON_BIN));
  cpSync(join(daemonDir, "claude"), join(staging, CLAUDE_BIN));
  chmodSync(join(staging, DAEMON_BIN), 0o755);
  chmodSync(join(staging, CLAUDE_BIN), 0o755);
  // Electron takes the app's name, and so the folder for its own data, from here.
  writeFileSync(
    join(staging, "package.json"),
    `${JSON.stringify({ name: "cycle", productName: APP_NAME, version, main: MAIN }, null, 2)}\n`,
  );
  writeFileSync(
    join(staging, BUILD_FILE),
    `${JSON.stringify({ name: APP_NAME, identifier: BUNDLE_ID, version, platform, arch, electron: electron.version }, null, 2)}\n`,
  );

  const app = join(outDir, platform === "darwin" ? MAC_BUNDLE : "Cycle");
  rmSync(app, { recursive: true, force: true });
  copyTree(platform === "darwin" ? join(electron.dist, "Electron.app") : electron.dist, app);
  const resources =
    platform === "darwin" ? join(app, "Contents/Resources") : join(app, "resources");
  rmSync(join(resources, "default_app.asar"), { force: true });
  const appDir = join(resources, "app");
  renameSync(staging, appDir);

  let executable: string;
  if (platform === "darwin") {
    const plistPath = join(app, "Contents/Info.plist");
    let plist = readFileSync(plistPath, "utf8");
    for (const [key, value] of [
      ["CFBundleIdentifier", BUNDLE_ID],
      ["CFBundleName", APP_NAME],
      ["CFBundleDisplayName", APP_NAME],
      ["CFBundleShortVersionString", version],
      ["CFBundleVersion", version],
    ] as const) {
      plist = setPlistString(plist, key, value);
    }
    // It names default_app.asar, which is gone; Cycle's code is a folder, which Electron does not check.
    writeFileSync(plistPath, removePlistDict(plist, "ElectronAsarIntegrity"));
    // Changing the bundle broke Electron's own signature, and Apple silicon runs nothing unsigned.
    run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", app]);
    executable = join(app, "Contents/MacOS/Electron");
  } else {
    executable = join(app, "cycle");
    renameSync(join(app, "electron"), executable);
  }
  return { app, appDir, executable, version };
};

if (import.meta.main) {
  const result = packageApp();
  console.log(JSON.stringify(result));
}
