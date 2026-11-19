/**
 * Bun gives a socket as callbacks; ACP wants a pair of streams. This is the glue: bytes in become a
 * ReadableStream, and writes wait for the socket to drain instead of being dropped when it is full.
 */
export type SocketLike = {
  write(data: Uint8Array): number;
  end(): void;
};

export class SocketAdapter {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #socket: SocketLike | undefined;
  #drained: (() => void) | undefined;
  #closed = false;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => this.#writeAll(chunk),
      close: () => {
        this.#socket?.end();
      },
      abort: () => {
        this.#socket?.end();
      },
    });
  }

  attach(socket: SocketLike): void {
    this.#socket = socket;
  }

  data(chunk: Uint8Array): void {
    if (!this.#closed) this.#controller.enqueue(new Uint8Array(chunk));
  }

  drain(): void {
    this.#drained?.();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#controller.close();
    } catch {}
    // A write waiting for room will not get it.
    this.#drained?.();
  }

  async #writeAll(chunk: Uint8Array): Promise<void> {
    let rest = chunk;
    while (rest.length > 0) {
      if (this.#closed || this.#socket === undefined) throw new Error("The connection is closed");
      const written = this.#socket.write(rest);
      if (written >= rest.length) return;
      rest = rest.subarray(Math.max(written, 0));
      await new Promise<void>((resolve) => {
        this.#drained = resolve;
      });
      this.#drained = undefined;
    }
  }
}
