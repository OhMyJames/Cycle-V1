/**
 * A stdio connector, served over streamable HTTP (docs/protocol.md §14). The daemon starts the
 * process itself, so its environment values go to it and to nothing else: the agent only ever sees
 * the gateway's address.
 *
 * One process per session and connector, started at the first request. The agent is its only client:
 * a POST writes its messages to the process and answers with the replies to its requests (JSON); a
 * GET opens the stream on which what the process says by itself (notifications, its own requests)
 * is sent; a DELETE ends it.
 */

export type Spawned = {
  stdin: { write(data: string): void; end(): void };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};

export type Spawn = (
  command: string[],
  options: { cwd: string; env: Record<string, string> },
) => Spawned;

export const bunSpawn: Spawn = (command, options) => {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    // What a server prints for people may hold its keys: not kept, not passed on.
    stderr: "ignore",
  });
  return {
    stdin: {
      write: (data) => {
        proc.stdin.write(data);
        proc.stdin.flush();
      },
      end: () => {
        proc.stdin.end();
      },
    },
    stdout: proc.stdout,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

type Message = { id?: string | number | null; method?: string };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Most a single line from the process may be before the process is taken for broken. */
const MAX_LINE = 16 * 1024 * 1024;
/** Messages the process said by itself while no stream was open: kept for the next one, up to this many. */
const MAX_WAITING = 256;

export class StdioBridge {
  readonly #process: Spawned;
  readonly #pending = new Map<string, (message: unknown) => void>();
  readonly #streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  #waiting: unknown[] = [];
  #ended = false;
  readonly ended: Promise<void>;

  constructor(process: Spawned, onEnd: (beforeAnswer: boolean) => void) {
    this.#process = process;
    let answered = false;
    this.ended = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of process.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > MAX_LINE && !buffer.includes("\n")) break;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line !== "") {
              answered = true;
              this.#received(line);
            }
            newline = buffer.indexOf("\n");
          }
        }
      } catch {
        // The process's output ended badly: the same as ending.
      }
      this.#end();
      onEnd(!answered);
    })();
  }

  #received(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not a message: a server that logs to stdout.
    }
    const m = message as Message;
    const isReply = m.method === undefined && m.id !== undefined && m.id !== null;
    const waiter = isReply ? this.#pending.get(JSON.stringify(m.id)) : undefined;
    if (waiter !== undefined) {
      this.#pending.delete(JSON.stringify(m.id));
      waiter(message);
      return;
    }
    const event = new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    if (this.#streams.size === 0) {
      this.#waiting.push(message);
      if (this.#waiting.length > MAX_WAITING) this.#waiting.shift();
      return;
    }
    for (const stream of this.#streams) stream.enqueue(event);
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const [key, waiter] of this.#pending) {
      const id = JSON.parse(key) as string | number;
      waiter({ jsonrpc: "2.0", id, error: { code: -32603, message: "The connector stopped" } });
    }
    this.#pending.clear();
    for (const stream of this.#streams) {
      try {
        stream.close();
      } catch {
        // Already closed by the reader.
      }
    }
    this.#streams.clear();
  }

  stop(): void {
    this.#process.kill();
    this.#end();
  }

  async handle(request: Request): Promise<Response> {
    if (this.#ended) return json(502, { error: "The connector stopped" });
    if (request.method === "DELETE") {
      this.stop();
      return new Response(null, { status: 200 });
    }
    if (request.method === "GET") {
      if (!(request.headers.get("accept") ?? "").includes("text/event-stream")) {
        return new Response(null, { status: 405 });
      }
      let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          mine = controller;
          this.#streams.add(controller);
          const encoder = new TextEncoder();
          for (const message of this.#waiting) {
            controller.enqueue(
              encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
            );
          }
          this.#waiting = [];
        },
        cancel: () => {
          if (mine !== undefined) this.#streams.delete(mine);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as Message[];
    const replies: Promise<unknown>[] = [];
    for (const message of messages) {
      if (typeof message !== "object" || message === null) continue;
      if (message.method !== undefined && message.id !== undefined && message.id !== null) {
        const key = JSON.stringify(message.id);
        replies.push(new Promise((resolve) => this.#pending.set(key, resolve)));
      }
      this.#process.stdin.write(`${JSON.stringify(message)}\n`);
    }
    if (replies.length === 0) return new Response(null, { status: 202 });
    const answers = await Promise.all(replies);
    return json(200, batch ? answers : answers[0]);
  }
}
