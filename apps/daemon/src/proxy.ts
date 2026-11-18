import { bridgeStdio, isListening } from "@cycle/transport/server";
import type { Paths } from "./config.ts";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

/** Starts a daemon that outlives this process, so a session goes on when an ssh connection drops. */
export const startDetached = (paths: Paths): void => {
  const child = Bun.spawn(
    ["bun", MAIN, "serve", "--data-dir", paths.dataDir, "--socket", paths.socket],
    { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env },
  );
  child.unref();
};

/**
 * `cycle-daemon proxy`: what a client runs over ssh. It joins its stdin and stdout to the daemon's
 * socket, and starts the daemon first if none is running.
 */
export const proxy = async (
  paths: Paths,
  io: { stdin: ReadableStream<Uint8Array>; stdout: WritableStream<Uint8Array> },
  wait = { total: 10_000, step: 50 },
): Promise<void> => {
  if (!(await isListening(paths.socket))) {
    startDetached(paths);
    const started = Date.now();
    while (!(await isListening(paths.socket))) {
      if (Date.now() - started > wait.total) {
        throw new Error(`The daemon did not start: nothing is listening on ${paths.socket}`);
      }
      await Bun.sleep(wait.step);
    }
  }
  await bridgeStdio(paths.socket, io);
};
