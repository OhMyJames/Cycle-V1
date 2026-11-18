import { ndJsonStream } from "@cycle/acp";
import type { Channel } from "./unix.ts";

export type SshOptions = {
  /** What `ssh` takes: `host`, `user@host`, or an alias from ~/.ssh/config. */
  host: string;
  /** What to run on the far side. It must speak ACP on stdin and stdout: `cycle-daemon proxy`. */
  command: string[];
  /** The ssh program. Replaceable for tests. */
  ssh?: string;
  /** Extra arguments, before the host. */
  args?: string[];
};

/**
 * Reaches a daemon over ssh. It uses the system's `ssh`, so keys, known_hosts and ~/.ssh/config
 * all apply and nothing of ssh is reimplemented. BatchMode is on: there is no one to type a
 * password, and a prompt would hang the connection.
 */
export const sshChannel = (options: SshOptions): Channel => {
  const proc = Bun.spawn(
    [
      options.ssh ?? "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ServerAliveInterval=15",
      ...(options.args ?? []),
      options.host,
      ...options.command,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const input = new WritableStream<Uint8Array>({
    write: (chunk) => {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close: () => {
      proc.stdin.end();
    },
  });
  return { stream: ndJsonStream(input, proc.stdout), close: () => proc.kill() };
};
