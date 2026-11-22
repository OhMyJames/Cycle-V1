// The app's entry. Everything is in app.ts; this says where things are.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { posthogSink } from "@cycle/analytics/posthog";
import { app } from "electron";
import { POSTHOG_HOST } from "../shared/posthog.ts";
import { RELEASE_REPO } from "../shared/release.ts";
import {
  fileAnalyticsStore,
  optedOutByEnvironment,
  projectOf,
  startAnalytics,
} from "./analytics.ts";
import { startApp, stayInBackground } from "./app.ts";
import { localHome } from "./home.ts";
import { BUILD_FILE, daemonCommand, loginShellPath } from "./layout.ts";
import { SWAP_SCRIPT, verifySameTeam } from "./updater.ts";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
// Only a test sets it: the packaged app is run on the developer's own Mac, and must not take the focus there. Said at
// once, before anything is awaited: macOS brings a regular app to the front as soon as it has started.
const hidden = env.CYCLE_TEST_HIDDEN_WINDOW === "1";
if (hidden) stayInBackground();
const packaged = existsSync(join(here, "..", BUILD_FILE));

const run = (
  program: string,
  args: string[],
  timeoutMs: number,
  environment?: Record<string, string>,
) =>
  new Promise<string>((done, fail) => {
    execFile(
      program,
      args,
      { timeout: timeoutMs, encoding: "utf8", ...(environment ? { env: environment } : {}) },
      (error, stdout) => (error ? fail(error) : done(stdout)),
    );
  });

// Not awaited at the top level: Electron loads an ES module main before it starts the event loop that
// emits "ready", so awaiting the app's own start here would wait for itself, forever.
const main = async () => {
  // Started from Finder, the app has launchd's bare PATH. The user's own is what Claude's tools need.
  const path =
    packaged && process.platform === "darwin" ? await loginShellPath(env.SHELL, run) : undefined;
  const daemon = daemonCommand({
    here,
    env,
    platform: process.platform,
    arch: process.arch,
    exists: existsSync,
  });
  const dataHome = localHome({ packaged, env, home: homedir() });
  const localEnv = {
    PATH: path ?? env.PATH ?? "",
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...(env.LANG !== undefined ? { LANG: env.LANG } : {}),
    // Where the daemon keeps its data: what the person chose, else (a run from source) a directory of its own,
    // else the daemon's default, which is the installed app's.
    ...(dataHome !== undefined ? { CYCLE_HOME: dataHome } : {}),
  };
  const info = buildInfo();
  // Reported to only with a project (the build has one, or the environment names one), and never against what the person
  // said: the environment's opt-out is checked here, before anything is made.
  const project = optedOutByEnvironment(env) ? undefined : projectOf(info, env);
  const analytics = await startAnalytics({
    store: fileAnalyticsStore(join(app.getPath("userData"), "analytics.json")),
    sink:
      project === undefined
        ? undefined
        : () => posthogSink({ apiKey: project.key, host: project.host ?? POSTHOG_HOST }),
    context: {
      app_version: info?.version ?? "dev",
      platform: process.platform,
      arch: process.arch,
    },
    onDrop: (name, reason) => console.warn(`[analytics] ${name} not sent: ${reason}`),
  });
  await startApp({
    analytics,
    rendererDir: join(here, "renderer"),
    preloadPath: join(here, "preload.cjs"),
    localCommand: [...daemon, "proxy"],
    localEnv,
    update: updateDeps(daemon, localEnv),
    ...(hidden ? { show: false } : {}),
  });
};

/** What the build recorded about itself (`package`), or nothing in a run from source. */
const buildInfo = (): { version: string; posthogKey?: string; posthogHost?: string } | undefined =>
  packaged ? JSON.parse(readFileSync(join(here, "..", BUILD_FILE), "utf8")) : undefined;

const localRelease = (url: string | undefined) => {
  if (url === undefined) return {};
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname))
    return {};
  const base = parsed.origin;
  return { apiBase: base, assetPrefix: `${base}/dl/` };
};

/** What the updater needs from this machine. Only an installed macOS app can replace itself. */
const updateDeps = (daemon: string[], localEnv: Record<string, string>) => {
  const info = packaged
    ? (JSON.parse(readFileSync(join(here, "..", BUILD_FILE), "utf8")) as {
        version: string;
        platform: string;
        arch: string;
      })
    : { version: "0.0.0", platform: process.platform, arch: process.arch };
  // dist -> app -> Resources -> Contents -> Cycle.app
  const appPath = resolve(here, "../../../..");
  const codesign = (args: string[]) =>
    new Promise<string>((done, fail) =>
      execFile("/usr/bin/codesign", args, { encoding: "utf8" }, (error, stdout, stderr) =>
        error ? fail(error) : done(`${stdout}${stderr}`),
      ),
    );
  return {
    current: info,
    appPath,
    repo: RELEASE_REPO,
    fetch,
    // For the test that updates a real bundle against a release served on this machine. Only a
    // loopback address is taken, so it can never point the app at somewhere else.
    ...localRelease(env.CYCLE_UPDATE_URL),
    disabled:
      packaged && process.platform === "darwin"
        ? undefined
        : "Updates are for the installed macOS app.",
    extract: (zip: string, into: string) =>
      run("/usr/bin/ditto", ["-x", "-k", zip, into], 300_000).then(() => {}),
    verifyBundle: verifySameTeam(codesign),
    log: (message: string) => console.warn(`[update] ${message}`),
    // The daemon the old app started runs from inside it and would outlive the swap, with its Claude gone.
    handOff: async (swap: { appPath: string; newApp: string; oldApp: string; staging: string }) => {
      await run(daemon[0] ?? "", [...daemon.slice(1), "stop"], 20_000, localEnv);
      const helper = spawn(
        "/bin/sh",
        [
          "-c",
          SWAP_SCRIPT,
          "cycle-swap",
          String(process.pid),
          swap.appPath,
          swap.newApp,
          swap.oldApp,
          swap.staging,
          "/usr/bin/open",
        ],
        { detached: true, stdio: "ignore" },
      );
      await new Promise<void>((resolve, reject) => {
        helper.once("error", reject);
        helper.once("spawn", resolve);
      });
      helper.unref();
    },
  };
};
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
