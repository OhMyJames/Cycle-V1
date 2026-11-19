// The half of the transport a daemon uses. It runs under Bun (Bun.listen, Bun.connect).
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { ndJsonStream } from "@cycle/acp";
import type { Channel } from "./channel.ts";
import { SocketAdapter } from "./socket-adapter.ts";

export class AlreadyRunningError extends Error {
  constructor(path: string) {
    super(`Something is already listening on ${path}`);
    this.name = "AlreadyRunningError";
  }
}

/** The path is something that is not a socket: a file or folder of someone's, which is not Cycle's to remove. */
export class NotASocketError extends Error {
  constructor(path: string) {
    super(`${path} exists and is not a socket, so it is left as it is; choose another --socket`);
    this.name = "NotASocketError";
  }
}

/** True if a process is accepting connections at `path`. */
export const isListening = async (path: string): Promise<boolean> => {
  try {
    const socket = await Bun.connect({
      unix: path,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
};

/**
 * Listens on a unix socket. Only its owner can connect: the socket is 0600, and the directory 0700 when
 * this made it (decision 0004). A directory that was already there is someone's, and keeps its
 * permissions: the socket's own are what keep others out. Refuses to start if another process is
 * already listening; a socket file left by one that died is removed, and anything else at the path
 * is left alone and refused.
 */
export const listenUnix = async (options: {
  path: string;
  onConnection: (channel: Channel) => void;
}): Promise<{ close: () => void }> => {
  const { path } = options;
  const folder = dirname(path);
  const existed = await lstat(folder).then(
    () => true,
    () => false,
  );
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (!existed) await chmod(folder, 0o700).catch(() => undefined);
  const found = await lstat(path).catch(() => undefined);
  if (found !== undefined) {
    if (!found.isSocket()) throw new NotASocketError(path);
    if (await isListening(path)) throw new AlreadyRunningError(path);
    await rm(path, { force: true });
  }
  const server = Bun.listen<{ adapter: SocketAdapter }>({
    unix: path,
    socket: {
      open(socket) {
        const adapter = new SocketAdapter();
        adapter.attach(socket);
        socket.data = { adapter };
        options.onConnection({
          stream: ndJsonStream(adapter.writable, adapter.readable),
          close: () => socket.end(),
        });
      },
      data(socket, chunk) {
        socket.data.adapter.data(chunk);
      },
      drain(socket) {
        socket.data.adapter.drain();
      },
      close(socket) {
        socket.data.adapter.close();
      },
      error(socket) {
        socket.data.adapter.close();
      },
    },
  });
  await chmod(path, 0o600);
  return {
    close: () => {
      server.stop(true);
      void rm(path, { force: true });
    },
  };
};

/**
 * Copies bytes between this process's stdin and stdout and a daemon's socket, untouched. This is
 * what `ssh host cycle proxy` runs on the far side. Resolves when either side closes.
 */
export const bridgeStdio = async (
  path: string,
  io: { stdin: ReadableStream<Uint8Array>; stdout: WritableStream<Uint8Array> },
): Promise<void> => {
  const adapter = new SocketAdapter();
  const socket = await Bun.connect({
    unix: path,
    socket: {
      open(s) {
        adapter.attach(s);
      },
      data(_s, chunk) {
        adapter.data(chunk);
      },
      drain() {
        adapter.drain();
      },
      close() {
        adapter.close();
      },
      error() {
        adapter.close();
      },
    },
  });
  adapter.attach(socket);
  const toDaemon = io.stdin.pipeTo(adapter.writable).catch(() => undefined);
  const toClient = adapter.readable.pipeTo(io.stdout).catch(() => undefined);
  await Promise.race([toDaemon, toClient]);
  socket.end();
};
