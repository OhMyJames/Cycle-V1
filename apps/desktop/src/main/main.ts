// The app's entry. Everything is in app.ts; this says where things are.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

// In development the daemon is run from the source tree with bun. A packaged app will run its own.
const daemon = env.CYCLE_DAEMON_MAIN ?? join(here, "../../daemon/src/main.ts");

// Not awaited at the top level: Electron loads an ES module main before it starts the event loop that
// emits "ready", so awaiting the app's own start here would wait for itself, forever.
startApp({
  rendererDir: join(here, "renderer"),
  preloadPath: join(here, "preload.cjs"),
  localCommand: [env.CYCLE_BUN ?? "bun", daemon, "proxy"],
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
