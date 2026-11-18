#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { AlreadyRunningError } from "@cycle/transport/server";
import { defaultDataDir, pathsFor } from "./config.ts";
import { proxy } from "./proxy.ts";
import { serve } from "./serve.ts";

const USAGE = `cycle-daemon <command> [options]

  serve   Run the daemon in the foreground.
  proxy   Join stdin and stdout to the daemon's socket, starting the daemon if needed.
          This is what a client runs over ssh.

Options:
  --data-dir <dir>   Where sessions and settings live. Default: $CYCLE_V1_HOME or ~/.cycle-v1
  --socket <path>    The unix socket. Default: <data-dir>/daemon.sock
`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "data-dir": { type: "string" },
    socket: { type: "string" },
    help: { type: "boolean" },
  },
  allowPositionals: true,
});
const command = positionals[0];
if (values.help || (command !== "serve" && command !== "proxy")) {
  console.error(USAGE);
  process.exit(command === undefined || values.help ? 0 : 2);
}
const paths = pathsFor(values["data-dir"] ?? defaultDataDir(), values.socket);

if (command === "serve") {
  try {
    const running = await serve(paths, (line) => console.error(`[cycle-daemon] ${line}`));
    const stop = async () => {
      await running.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      console.error(error.message);
      process.exit(3);
    }
    throw error;
  }
} else {
  // stdout is the protocol: nothing else may be written to it.
  await proxy(paths, {
    stdin: Bun.stdin.stream(),
    stdout: new WritableStream({
      write: (chunk) => {
        process.stdout.write(chunk);
      },
    }),
  });
  process.exit(0);
}
