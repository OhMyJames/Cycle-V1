import { appendFile, mkdir, open, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { logUnavailable } from "../errors.ts";
import type { LogRecord, LogStore, NewRecord, ReadRange, SessionLog } from "./types.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type JsonlStoreOptions = {
  /** The directory the sessions' files go in. Always given: nothing here guesses a home. */
  dir: string;
  now?: () => Date;
};

const isRecord = (value: unknown): value is LogRecord =>
  typeof value === "object" &&
  value !== null &&
  Number.isInteger((value as LogRecord).seq) &&
  typeof (value as LogRecord).ts === "string" &&
  typeof (value as LogRecord).kind === "string";

/**
 * Parses a file's text into records, checking that seq is 1, 2, 3, ... If there is a half line at
 * the end, from a crash, it is left out and `validBytes` says where the good part ends.
 */
export const parseLog = (
  sessionId: string,
  text: string,
): { records: LogRecord[]; validBytes: number } => {
  const end = text.lastIndexOf("\n") + 1;
  const records: LogRecord[] = [];
  if (end > 0) {
    const lines = text.slice(0, end - 1).split("\n");
    for (const [index, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw logUnavailable(sessionId, `line ${index + 1} is not JSON`);
      }
      if (!isRecord(parsed)) throw logUnavailable(sessionId, `line ${index + 1} is not a record`);
      if (parsed.seq !== index + 1) {
        throw logUnavailable(sessionId, `line ${index + 1} has seq ${parsed.seq}`);
      }
      records.push(parsed);
    }
  }
  return { records, validBytes: Buffer.byteLength(text.slice(0, end)) };
};

class JsonlSessionLog implements SessionLog {
  readonly sessionId: string;
  readonly #path: string;
  readonly #now: () => Date;
  readonly #listeners = new Set<(record: LogRecord) => void>();
  #last: number;
  #updated: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(
    sessionId: string,
    path: string,
    last: number,
    updated: string | undefined,
    now: () => Date,
  ) {
    this.sessionId = sessionId;
    this.#path = path;
    this.#last = last;
    this.#updated = updated;
    this.#now = now;
  }

  lastSeq(): number {
    return this.#last;
  }

  updatedAt(): string | undefined {
    return this.#updated;
  }

  append(record: NewRecord): Promise<LogRecord> {
    // One at a time, in the order called, so seq and the file agree.
    const run = this.#queue.then(() => this.#write(record));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #write(record: NewRecord): Promise<LogRecord> {
    if (this.#closed) throw logUnavailable(this.sessionId, "the log is closed");
    const stored: LogRecord = {
      seq: this.#last + 1,
      ts: this.#now().toISOString(),
      kind: record.kind,
      data: record.data,
    };
    try {
      await appendFile(this.#path, `${JSON.stringify(stored)}\n`);
    } catch (error) {
      throw logUnavailable(this.sessionId, String(error));
    }
    this.#last = stored.seq;
    if (stored.kind !== "meta") this.#updated = stored.ts;
    for (const listener of [...this.#listeners]) listener(stored);
    return stored;
  }

  async read(range: ReadRange = {}): Promise<LogRecord[]> {
    const after = range.after ?? 0;
    const upTo = range.upTo ?? Number.POSITIVE_INFINITY;
    const text = await Bun.file(this.#path)
      .text()
      .catch((error) => {
        throw logUnavailable(this.sessionId, String(error));
      });
    const { records } = parseLog(this.sessionId, text);
    return records.filter((r) => r.seq > after && r.seq <= upTo);
  }

  subscribe(listener: (record: LogRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.#queue;
    this.#closed = true;
    this.#listeners.clear();
  }
}

export class JsonlLogStore implements LogStore {
  readonly #dir: string;
  readonly #now: () => Date;
  readonly #open = new Set<string>();

  constructor(options: JsonlStoreOptions) {
    this.#dir = options.dir;
    this.#now = options.now ?? (() => new Date());
  }

  #path(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) throw logUnavailable(sessionId, "not a usable session id");
    return join(this.#dir, `${sessionId}.jsonl`);
  }

  async exists(sessionId: string): Promise<boolean> {
    return stat(this.#path(sessionId)).then(
      () => true,
      () => false,
    );
  }

  async open(sessionId: string): Promise<SessionLog> {
    const path = this.#path(sessionId);
    if (this.#open.has(sessionId)) throw logUnavailable(sessionId, "the log is already open");
    // Taken before anything is awaited: two opens at once cannot both get the file.
    this.#open.add(sessionId);
    let text: string;
    let records: LogRecord[];
    try {
      await mkdir(this.#dir, { recursive: true });
      // Make sure the file exists, then read what is there.
      await (await open(path, "a")).close();
      text = await Bun.file(path).text();
      const parsed = parseLog(sessionId, text);
      records = parsed.records;
      // A crash can leave half a line. It is cut off now, before anything is appended: otherwise
      // the next record would be glued to it, and the damage would be in the middle of the file.
      if (parsed.validBytes < Buffer.byteLength(text)) await truncate(path, parsed.validBytes);
    } catch (error) {
      this.#open.delete(sessionId);
      throw error;
    }
    const updated = records.findLast((record) => record.kind !== "meta")?.ts;
    const log = new JsonlSessionLog(sessionId, path, records.length, updated, this.#now);
    const close = log.close.bind(log);
    log.close = async () => {
      await close();
      this.#open.delete(sessionId);
    };
    return log;
  }

  async remove(sessionId: string): Promise<void> {
    if (this.#open.has(sessionId)) throw logUnavailable(sessionId, "the log is open");
    await rm(this.#path(sessionId), { force: true });
  }
}
