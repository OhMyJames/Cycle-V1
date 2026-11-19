import { closeSync, mkdirSync, openSync, readFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./config.ts";
import { selfCommand } from "./self.ts";
import { bridgeStdio, isListening } from "./transport/server.ts";

const LOG_NAME = "daemon.log";
const LOG_LIMIT = 1_000_000;

export const logPath = (paths: Paths): string => join(paths.dataDir, LOG_NAME);

/** The last of what the daemon wrote, for an error that has to say why it did not start. */
const logTail = (paths: Paths): string => {
  try {
    return readFileSync(logPath(paths), "utf8").trim().slice(-1500);
  } catch {
    return "";
  }
};

/**
 * Starts a daemon that outlives this process, so a session goes on when an ssh connection drops.
 * What it writes goes to `<data dir>/daemon.log`: with nobody watching its output, that file is the only
 * way to learn why it did not start or why it stopped.
 */
export const startDetached = (paths: Paths): { exited: () => boolean } => {
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const log = logPath(paths);
  // One run's worth is enough to find a reason; the file does not grow for ever.
  try {
    if (statSync(log).size > LOG_LIMIT) truncateSync(log, 0);
  } catch {}
  const fd = openSync(log, "a", 0o600);
  try {
    const child = Bun.spawn(
      [...selfCommand(), "serve", "--data-dir", paths.dataDir, "--socket", paths.socket],
      { detached: true, stdin: "ignore", stdout: fd, stderr: fd, env: process.env },
    );
    child.unref();
    return { exited: () => child.exitCode !== null };
  } finally {
    closeSync(fd);
  }
};

/**
 * `cycle proxy`: what a client runs over ssh. It joins its stdin and stdout to the daemon's
 * socket, and starts the daemon first if none is running. A first start of a new executable can be
 * slow (macOS looks at it before it runs it), so it is given time.
 */
export const proxy = async (
  paths: Paths,
  io: { stdin: ReadableStream<Uint8Array>; stdout: WritableStream<Uint8Array> },
  wait = { total: 30_000, step: 50 },
): Promise<void> => {
  if (!(await isListening(paths.socket))) {
    const daemon = startDetached(paths);
    const started = Date.now();
    while (!(await isListening(paths.socket))) {
      // One that has already exited is not going to start: no reason to wait out the time.
      if (daemon.exited() || Date.now() - started > wait.total) {
        await Bun.sleep(50);
        const said = logTail(paths);
        throw new Error(
          `The daemon did not start: nothing is listening on ${paths.socket}${
            said !== "" ? `\nIts log (${logPath(paths)}):\n${said}` : ""
          }`,
        );
      }
      await Bun.sleep(wait.step);
    }
  }
  await bridgeStdio(paths.socket, io);
};
