import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Daemon } from "@cycle/daemon";
import { listenUnix } from "@cycle/transport";
import { agentsFor } from "./agents.ts";
import { loadConfig, type Paths } from "./config.ts";

/** Runs the daemon until `close` is called. */
export const serve = async (paths: Paths, log: (line: string) => void = () => {}) => {
  const config = await loadConfig(paths.config);
  const daemon = await Daemon.start({
    dataDir: paths.dataDir,
    agents: agentsFor(config, paths.dataDir),
  });
  let clients = 0;
  const server = await listenUnix({
    path: paths.socket,
    onConnection: ({ stream }) => {
      const id = ++clients;
      log(`client ${id} connected`);
      void daemon.accept(stream).closed.then(() => log(`client ${id} left`));
    },
  });
  const pidFile = join(paths.dataDir, "daemon.pid");
  await writeFile(pidFile, `${process.pid}\n`);
  log(`listening on ${paths.socket}`);
  return {
    close: async () => {
      await rm(pidFile, { force: true });
      server.close();
      await daemon.close();
    },
  };
};
