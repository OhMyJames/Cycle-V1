// Inputs copied from the release job. Keep the signed bytes intact, including the stapled ticket.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { teamOf } from "../../src/main/updater.ts";
import { manifestName, parseManifest } from "../../src/shared/release.ts";

export const run = (command: string[]) => {
  const result = Bun.spawnSync(command, { timeout: 120_000 });
  if (!result.success) throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
};

export const signedTeam = (app: string) => {
  run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
  run(["/usr/sbin/spctl", "--assess", "--type", "execute", app]);
  run(["/usr/bin/xcrun", "stapler", "validate", app]);
  const listing = Bun.spawnSync(["/usr/bin/codesign", "-dv", "--verbose=4", app]);
  const details = listing.stderr.toString();
  const team = teamOf(details);
  if (!listing.success || !team || !/^Authority=Developer ID Application:/m.test(details))
    throw new Error(`Expected a Developer ID Application signature on ${app}`);
  return team;
};

export const unpackSignedRelease = async (dir: string, into: string) => {
  const json = await readFile(join(dir, manifestName(process.platform, process.arch)), "utf8");
  const manifest = parseManifest(json);
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error("The release is for a different platform.");
  const zip = join(dir, manifest.file);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(zip)) hash.update(chunk);
  if (Bun.file(zip).size !== manifest.size || hash.digest("hex") !== manifest.sha256)
    throw new Error(`Release archive does not match its manifest: ${zip}`);
  run(["/usr/bin/ditto", "-x", "-k", zip, into]);
  const app = join(into, "Cycle.app");
  const team = signedTeam(app);
  const info = await Bun.file(join(app, "Contents/Resources/app/build.json")).json();
  if (
    info.version !== manifest.version ||
    info.platform !== manifest.platform ||
    info.arch !== manifest.arch
  )
    throw new Error("The signed bundle does not match its release manifest.");
  return { json, manifest, zip, team };
};
