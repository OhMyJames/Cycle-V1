// The app's entry. Everything is in app.ts; this says where things are.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

// Which daemon the local host runs, first that exists:
//   CYCLE_DAEMON_BIN   a built cycle-daemon executable you name
//   the one `bun run build` made in apps/daemon/dist (what you get after building everything)
//   the source, run with bun (development)
const built = join(
  here,
  `../../daemon/dist/cycle-daemon-${process.platform}-${process.arch}/cycle-daemon`,
);
const daemonCommand = (): string[] => {
  if (env.CYCLE_DAEMON_BIN !== undefined) return [env.CYCLE_DAEMON_BIN];
  if (existsSync(built)) return [built];
  return [env.CYCLE_BUN ?? "bun", env.CYCLE_DAEMON_MAIN ?? join(here, "../../daemon/src/main.ts")];
};

// Not awaited at the top level: Electron loads an ES module main before it starts the event loop that
// emits "ready", so awaiting the app's own start here would wait for itself, forever.
startApp({
  rendererDir: join(here, "renderer"),
  preloadPath: join(here, "preload.cjs"),
  localCommand: [...daemonCommand(), "proxy"],
  localEnv: {
    PATH: env.PATH ?? "",
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...(env.LANG !== undefined ? { LANG: env.LANG } : {}),
    // Where the daemon keeps its data, if the user chose.
    ...(env.CYCLE_V1_HOME !== undefined ? { CYCLE_V1_HOME: env.CYCLE_V1_HOME } : {}),
  },
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
