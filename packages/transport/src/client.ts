// The half of the transport a client uses. It must run in Electron's main process, which is Node
// and not Bun, so it uses node:net and node:child_process and nothing of Bun's own API (scripts/check.ts checks).
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { Duplex, Readable, Writable } from "node:stream";
import { ndJsonStream } from "@cycle/acp";
import type { Channel } from "./channel.ts";

export type { Channel } from "./channel.ts";

/** Connects to a daemon's unix socket. */
export const connectUnix = (path: string): Promise<Channel> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      // A socket that errors later just ends: the stream closes and the client reconnects.
      socket.on("error", () => socket.destroy());
      const { readable, writable } = Duplex.toWeb(socket);
      resolve({
        stream: ndJsonStream(
          writable as WritableStream<Uint8Array>,
          readable as unknown as ReadableStream<Uint8Array>,
        ),
        close: () => socket.destroy(),
      });
    });
  });

export type CommandOptions = {
  command: string[];
  /** The child's whole environment. Default: this process's. */
  env?: Record<string, string>;
  cwd?: string;
};

/** Runs a command and speaks ACP over its stdin and stdout. */
export const commandChannel = (options: CommandOptions): Channel => {
  const [program, ...args] = options.command;
  if (program === undefined) throw new Error("No command to run");
  const child = spawn(program, args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
  // A command that cannot start (no such program) ends the stream rather than crashing the process.
  child.on("error", () => child.stdin.destroy());
  child.stdin.on("error", () => undefined);
  // What it says on standard error is the reason it failed (ssh: "Permission denied", the shell: "No such
  // file"). The last of it is kept for whoever has to tell the user, and it still reaches this process's own.
  let said = "";
  child.stderr.on("data", (chunk: Buffer) => {
    said = `${said}${chunk.toString()}`.slice(-2000);
    process.stderr.write(chunk);
  });
  return {
    diagnostics: () => said.trim(),
    stream: ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    ),
    close: () => {
      child.kill();
    },
  };
};

export type SshOptions = {
  /** What `ssh` takes: `host`, `user@host`, or an alias from ~/.ssh/config. */
  host: string;
  /** What to run on the far side. It must speak ACP on stdin and stdout: `cycle proxy`. */
  command: string[];
  /** The ssh program. Replaceable for tests. */
  ssh?: string;
  /** Extra arguments, before the host. */
  args?: string[];
  env?: Record<string, string>;
};

/**
 * Reaches a daemon over ssh. It uses the system's `ssh`, so keys, known_hosts and ~/.ssh/config all
 * apply and nothing of ssh is reimplemented. BatchMode is on: there is no one to type a password,
 * and a prompt would hang the connection.
 */
export const sshChannel = (options: SshOptions): Channel => {
  return commandChannel({
    command: [
      options.ssh ?? "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ServerAliveInterval=15",
      ...(options.args ?? []),
      // Whatever the host is, it is the host: ssh reads a word that starts with "-" as an option unless this ends them
      // (-oProxyCommand=... would run a command here).
      "--",
      options.host,
      ...options.command,
    ],
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
};
