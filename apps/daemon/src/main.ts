#!/usr/bin/env bun
import { join } from "node:path";
import { runAdapter } from "@cycle/adapter-claude/run";
import { AlreadyRunningError, isListening } from "@cycle/transport/server";
import { claudeEnv } from "./agents.ts";
import { parseCli } from "./args.ts";
import { defaultDataDir, loadConfig, pathsFor } from "./config.ts";
import { proxy } from "./proxy.ts";
import { claudeExecutable } from "./self.ts";
import { serve } from "./serve.ts";
import { VERSION } from "./version.ts";

const USAGE = `cycle <command> [options]

  serve   Run the daemon in the foreground.
  proxy   Join stdin and stdout to the daemon's socket, starting the daemon if needed.
          This is what a client runs over ssh.
  version Print this build's version ("dev" when run from source).
  status  Say whether the daemon is running (exit 0) or not (exit 1).
  stop    Stop the daemon if it is running.
  login   Sign in to Claude for this daemon: "claude auth login" with the environment and
          config directory the daemon gives Claude. Run it on the machine the daemon is on.
  claude <args>   Run the Claude binary with that same environment (e.g. claude auth status).
          Everything after login or claude goes to Claude as typed, --help included.
  adapter claude   (internal) Run the Claude adapter on stdin and stdout.

Options:
  --data-dir <dir>   Where sessions and settings live. Default: $CYCLE_HOME or ~/.cycle
  --socket <path>    The unix socket. Default: <data-dir>/daemon.sock
`;

const { values, positionals, forwarded } = parseCli(Bun.argv.slice(2));
const command = positionals[0];
if (command === "adapter" && positionals[1] === "claude") {
  await runAdapter();
  process.exit(0);
}
if (command === "version") {
  console.log(VERSION);
  process.exit(0);
}
const commands = ["serve", "proxy", "status", "stop", "login", "claude"];
if (values.help || command === undefined || !commands.includes(command)) {
  console.error(USAGE);
  process.exit(command === undefined || values.help ? 0 : 2);
}
const paths = pathsFor(values["data-dir"] ?? defaultDataDir(), values.socket);

if (command === "serve") {
  try {
    const running = await serve(paths, (line) => console.error(`[cycle] ${line}`));
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
} else if (command === "login" || command === "claude") {
  // Claude's own sign-in, in the one place its login is kept: the same config directory and
  // environment the daemon gives the Claude it runs (config.json), and nothing else of this shell's.
  const config = await loadConfig(paths.config);
  const executable = claudeExecutable() ?? Bun.which("claude");
  if (executable === null || executable === undefined) {
    console.error("No Claude binary: it is meant to sit beside cycle, or be on PATH.");
    process.exit(1);
  }
  const rest = command === "login" ? ["auth", "login", ...(forwarded ?? [])] : (forwarded ?? []);
  const child = Bun.spawn([executable, ...rest], {
    env: claudeEnv(config.claude, paths.dataDir, process.env),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
} else if (command === "status") {
  const up = await isListening(paths.socket);
  console.log(up ? `running, listening on ${paths.socket}` : `not running (${paths.socket})`);
  process.exit(up ? 0 : 1);
} else if (command === "stop") {
  const pid = Number(
    (
      await Bun.file(join(paths.dataDir, "daemon.pid"))
        .text()
        .catch(() => "")
    ).trim(),
  );
  if (!(await isListening(paths.socket)) || !Number.isInteger(pid) || pid <= 0) {
    console.log("not running");
    process.exit(0);
  }
  process.kill(pid, "SIGTERM");
  const started = Date.now();
  while ((await isListening(paths.socket)) && Date.now() - started < 10_000) await Bun.sleep(50);
  const gone = !(await isListening(paths.socket));
  console.log(gone ? "stopped" : "did not stop within 10s");
  process.exit(gone ? 0 : 1);
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
