import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentsFor } from "./claude-agent.ts";
import { type Config, ConfigSchema, loadConfig, type Paths } from "./config.ts";
import { Daemon } from "./daemon.ts";
import { errorText, type FileLogger, fileLogger } from "./logger.ts";
import { listenUnix } from "./transport/server.ts";
import { VERSION } from "./version.ts";

export type ServeOptions = {
  /** Each line the log writes is also given here (the foreground `cycle serve` at a terminal). */
  echo?: (line: string) => void;
};

const loggerFor = (paths: Paths, config: Config, echo?: (line: string) => void): FileLogger =>
  fileLogger({ path: paths.log, ...config.log, ...(echo !== undefined ? { echo } : {}) });

/**
 * Runs the daemon until `close` is called. What it does and what goes wrong is in its log (docs/daemon.md "日志"),
 * which `log` is, for the caller to say why it is stopping.
 */
export const serve = async (paths: Paths, options: ServeOptions = {}) => {
  let config: Config;
  try {
    config = await loadConfig(paths.config);
  } catch (error) {
    // The settings for the log are in what could not be read: the reason goes to a log with the defaults.
    const log = loggerFor(paths, ConfigSchema.parse({}), options.echo);
    log.error("start_failed", { error: errorText(error) });
    log.close();
    throw error;
  }
  const log = loggerFor(paths, config, options.echo);
  log.info("daemon_starting", { version: VERSION, pid: process.pid, level: config.log.level });
  let daemon: Daemon;
  let server: Awaited<ReturnType<typeof listenUnix>>;
  try {
    daemon = await Daemon.start({
      dataDir: paths.dataDir,
      agents: agentsFor(config, paths.dataDir, process.env, log),
      version: VERSION,
      log,
      ...(config.claude.warmStart ? { maxAheadAgents: config.claude.maxWarm } : {}),
    });
    let clients = 0;
    server = await listenUnix({
      path: paths.socket,
      onConnection: ({ stream }) => {
        const id = ++clients;
        log.info("client_connected", { client: id });
        void daemon.accept(stream).closed.then(() => log.info("client_left", { client: id }));
      },
    });
  } catch (error) {
    log.error("start_failed", { error: errorText(error) });
    log.close();
    throw error;
  }
  const pidFile = join(paths.dataDir, "daemon.pid");
  await writeFile(pidFile, `${process.pid}\n`);
  log.info("listening", { socket: paths.socket });
  return {
    log,
    close: async () => {
      const working = daemon.activity();
      log.info("daemon_stopping", {
        working: working.length,
        turns: working.filter((w) => w.turn).length,
      });
      await rm(pidFile, { force: true });
      server.close();
      await daemon.close();
      log.info("daemon_stopped");
      log.close();
    },
  };
};

/**
 * A served daemon stops on SIGINT or SIGTERM, saying which; and what brings it down unexpectedly (an exception nothing
 * caught, a promise nothing awaited) is in its log with where in the code, before it exits with 1. That is the reason a
 * person looks for afterwards (docs/daemon.md "日志").
 */
export const onSignalsAndCrashes = (running: Awaited<ReturnType<typeof serve>>): void => {
  let stopping = false;
  const stop = (signal: string) => async () => {
    if (stopping) return;
    stopping = true;
    running.log.info("signal", { signal });
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", stop("SIGINT"));
  process.on("SIGTERM", stop("SIGTERM"));
  const died = (kind: string) => (error: unknown) => {
    running.log.error(kind, { error: errorText(error, true) });
    console.error(error);
    process.exit(1);
  };
  process.on("uncaughtException", died("uncaught_exception"));
  process.on("unhandledRejection", died("unhandled_rejection"));
};
