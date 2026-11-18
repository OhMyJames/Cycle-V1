// The app's entry. Everything is in app.ts; this says where things are.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./app.ts";
import { BUILD_FILE, daemonCommand, loginShellPath } from "./layout.ts";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const packaged = existsSync(join(here, "..", BUILD_FILE));

const run = (shell: string, args: string[], timeoutMs: number) =>
  new Promise<string>((resolve, reject) => {
    execFile(shell, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

// Not awaited at the top level: Electron loads an ES module main before it starts the event loop that
// emits "ready", so awaiting the app's own start here would wait for itself, forever.
const main = async () => {
  // Started from Finder, the app has launchd's bare PATH. The user's own is what Claude's tools need.
  const path =
    packaged && process.platform === "darwin" ? await loginShellPath(env.SHELL, run) : undefined;
  await startApp({
    rendererDir: join(here, "renderer"),
    preloadPath: join(here, "preload.cjs"),
    localCommand: [
      ...daemonCommand({
        here,
        env,
        platform: process.platform,
        arch: process.arch,
        exists: existsSync,
      }),
      "proxy",
    ],
    localEnv: {
      PATH: path ?? env.PATH ?? "",
      ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
      ...(env.LANG !== undefined ? { LANG: env.LANG } : {}),
      // Where the daemon keeps its data, if the user chose.
      ...(env.CYCLE_HOME !== undefined ? { CYCLE_HOME: env.CYCLE_HOME } : {}),
    },
  });
};
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
