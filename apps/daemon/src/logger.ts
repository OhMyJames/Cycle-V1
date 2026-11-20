// The daemon's own log: what it did and what went wrong, for someone looking at a machine after the fact.
// docs/daemon.md "日志". It records events, never content: no prompt, no agent output, no credential.
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { redactText } from "./redact.ts";

export const LEVELS = ["error", "warn", "info", "debug"] as const;
export type Level = (typeof LEVELS)[number];

/** What an event carries: ids, counts, codes, reasons. A string is filtered and cut short before it is written. */
export type Fields = Record<string, string | number | boolean | undefined | null>;

export type Logger = {
  error(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  debug(event: string, fields?: Fields): void;
};

/** Says nothing: for tests, and for a daemon run with no log. */
export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

/** The longest a value is written: a reason is enough to find a cause, and a long value is more likely content. */
const MAX_VALUE = 500;

const shown = (value: string | number | boolean): string => {
  if (typeof value !== "string") return String(value);
  let text = redactText(value);
  if (text.length > MAX_VALUE) text = `${text.slice(0, MAX_VALUE)}…(${value.length} chars)`;
  // One event, one line: a value with a space, a quote or a line break in it is quoted, and its line breaks escaped.
  return /[\s"=\\]/.test(text) || text === "" ? JSON.stringify(text) : text;
};

/** One line: time, level, event, then `key=value` for each field given. */
export const formatLine = (
  time: Date,
  level: Level,
  event: string,
  fields: Fields = {},
): string => {
  const parts = [time.toISOString(), level.toUpperCase().padEnd(5), event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${shown(value)}`);
  }
  return `${parts.join(" ")}\n`;
};

/** What an error is, for the log: its message, and with `stack` its stack (code, never content). */
export const errorText = (error: unknown, stack = false): string => {
  if (!(error instanceof Error)) return String(error);
  return stack && error.stack !== undefined ? error.stack : error.message;
};

export type FileLoggerOptions = {
  path: string;
  /** Events below this level are not written. */
  level: Level;
  /** Past this size the file is rotated: `daemon.log` becomes `daemon.log.1`, and so on. */
  maxBytes: number;
  /** How many rotated files are kept beside the current one; the oldest is removed. */
  files: number;
  /** Also writes each line here (the foreground `cycle serve` at a terminal). */
  echo?: (line: string) => void;
  now?: () => Date;
};

export type FileLogger = Logger & { close(): void };

/**
 * Writes to a file only its owner can read (0600), in a directory only its owner can enter. Writes are synchronous:
 * a daemon that is about to exit has what it said about why on disk. The file and the rotated ones together stay
 * under `maxBytes × (files + 1)`, for a small machine.
 */
export const fileLogger = (options: FileLoggerOptions): FileLogger => {
  const { path, maxBytes, files } = options;
  const threshold = LEVELS.indexOf(options.level);
  const now = options.now ?? (() => new Date());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  let size = 0;
  const open = () => {
    fd = openSync(path, "a", 0o600);
    // A file that was there before with wider permissions is narrowed: the mode above applies only to a new one.
    chmodSync(path, 0o600);
    size = fstatSync(fd).size;
  };
  const rotate = () => {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
    rmSync(`${path}.${files}`, { force: true });
    for (let i = files - 1; i >= 1; i--) {
      if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    }
    if (files >= 1) renameSync(path, `${path}.1`);
    else rmSync(path, { force: true });
    open();
  };
  let broken = false;
  const write = (level: Level, event: string, fields?: Fields) => {
    if (LEVELS.indexOf(level) > threshold) return;
    const line = formatLine(now(), level, event, fields);
    options.echo?.(line);
    // A log that cannot be written does not stop the daemon: it goes on, quietly, without one.
    if (broken) return;
    try {
      if (fd === undefined) open();
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) rotate();
      writeSync(fd as number, line);
      size += bytes;
    } catch {
      broken = true;
    }
  };
  return {
    error: (event, fields) => write("error", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    info: (event, fields) => write("info", event, fields),
    debug: (event, fields) => write("debug", event, fields),
    close: () => {
      if (fd !== undefined) closeSync(fd);
      fd = undefined;
    },
  };
};

/** The last `count` lines of a text, each ending in a newline. */
export const tailLines = (text: string, count: number): string => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length === 0 ? "" : `${lines.slice(-count).join("\n")}\n`;
};
