// `bun run release-assets` (macOS): turns the app `bun run package` built (and sign.ts signed) into
// what a GitHub release carries for this platform: an archive and the manifest the updater reads.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanBundle } from "../src/main/delta.ts";
import { BUILD_FILE, MAC_BUNDLE } from "../src/main/layout.ts";
import { archiveName, manifestFor, manifestName } from "../src/shared/release.ts";
import { BUILD_DIR } from "./package.ts";

const OUT_DIR = join(BUILD_DIR, "release");
const app = join(BUILD_DIR, MAC_BUNDLE);
const buildFile = join(app, "Contents/Resources/app", BUILD_FILE);
if (process.platform !== "darwin") throw new Error("Release assets are made on macOS.");
if (!existsSync(buildFile)) throw new Error(`${app} is not built. Run \`bun run package\`.`);
const info = JSON.parse(readFileSync(buildFile, "utf8")) as {
  version: string;
  platform: string;
  arch: string;
};

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
const archive = join(OUT_DIR, archiveName(info.version, info.platform, info.arch));
// As Finder compresses: the bundle itself at the top, with what its signature needs kept.
const zipped = Bun.spawnSync(
  ["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (!zipped.success) throw new Error(`Could not archive ${app}.`);

const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
// What the bundle holds, file by file: an installed app that has most of it fetches only the rest.
const tree = await scanBundle(app);
const manifest = join(OUT_DIR, manifestName(info.platform, info.arch));
writeFileSync(
  manifest,
  `${JSON.stringify(manifestFor(info, { sha256, size: statSync(archive).size }, tree))}\n`,
);
console.log(JSON.stringify({ archive, manifest }));
