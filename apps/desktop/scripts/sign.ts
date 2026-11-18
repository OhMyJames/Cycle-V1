// `bun run sign` (macOS, CI): gives the packaged app the Developer ID identity the release workflow
// imported, has Apple notarize it, and lets the notarizer staple the ticket.
//
// The identity is found by codesign in the keychain the workflow put in the search list. The App Store
// Connect API key is a file whose path is APPLE_API_KEY_PATH; its id and issuer are in the environment.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { notarize } from "@electron/notarize";
import { sign } from "@electron/osx-sign";
import { MAC_BUNDLE } from "../src/main/layout.ts";
import { BUILD_DIR } from "./package.ts";

if (process.platform !== "darwin") throw new Error("Signing is for a macOS build.");

const app = join(BUILD_DIR, MAC_BUNDLE);
if (!existsSync(app)) throw new Error(`${app} is not built. Run \`bun run package\`.`);

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

// Two ways to hold the credentials, and neither is passed on the command line:
//  - on the owner's own Mac (self-hosted runner): the Developer ID identity is in the login keychain,
//    and the notarization credentials are a notarytool keychain profile (`xcrun notarytool
//    store-credentials <name> ...`), named in APPLE_NOTARY_PROFILE. No secret leaves that machine.
//  - on a GitHub-hosted runner: the workflow imports the identity into a temporary keychain, and the
//    App Store Connect API key is a file at APPLE_API_KEY_PATH, with its id and issuer in the environment.
const profile = process.env.APPLE_NOTARY_PROFILE?.trim();
const identity = process.env.APPLE_SIGN_IDENTITY?.trim();

// Inside out, hardened runtime, a secure timestamp, and osx-sign's default entitlements (which let
// the compiled daemon and Claude, both Bun executables, run under the hardened runtime).
await sign({ app, platform: "darwin", ...(identity ? { identity } : {}) });
await notarize(
  profile
    ? { appPath: app, keychainProfile: profile }
    : {
        appPath: app,
        appleApiKey: required("APPLE_API_KEY_PATH"),
        appleApiKeyId: required("APPLE_API_KEY_ID"),
        appleApiIssuer: required("APPLE_API_ISSUER"),
      },
);
console.log(JSON.stringify({ signed: app, credentials: profile ? "keychain profile" : "api key" }));
