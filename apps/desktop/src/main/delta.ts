// Updating by the difference: the new bundle is assembled from the files the installed one already
// has and, from the release's archive, only the files that changed, which are fetched with HTTP Range
// requests (GitHub serves them) without downloading the rest of the archive.
//
// What is trusted is the release's file table (`ReleaseManifest.tree`), not the archive's bytes: every
// file that goes into the new bundle, copied or fetched, is hashed and must equal the table's SHA-256,
// and the bundle's shape (the files, links, folders and modes) must equal the table exactly. Anything
// that does not hold throws, and the updater then downloads the whole archive instead.
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import type { TreeEntry } from "../shared/release.ts";
import {
  END_SEARCH,
  LOCAL_HEADER,
  parseDirectory,
  parseEnd,
  parseLocal,
  type ZipEntry,
} from "../shared/zip.ts";
import { MAC_BUNDLE } from "./layout.ts";

/** Not an error: the difference is not worth fetching, so the whole archive should be. */
export class DeltaDeclined extends Error {}

/** More than this share of the archive to fetch, and fetching all of it in one piece is the better way. */
const WORTH_IT = 0.8;
/** The room a local header's extra field may take beyond the central directory's name length. */
const HEADER_ROOM = 1024;
/** Files this small, close to each other in the archive, are fetched in one request. */
const SMALL = 1 << 20;
const GAP = 64 << 10;
const GROUP_MAX = 16 << 20;
const PARALLEL = 4;

const hashOf = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
};

/** At most `limit` of these at a time; the first failure is thrown once the running ones end. */
const pool = async <T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) => {
  let next = 0;
  let failure: unknown;
  let failed = false;
  const lane = async () => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await work(item);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failed) throw failure;
};

/**
 * The table of the bundle at `root`, as the release script writes it: links are read, not followed,
 * and the files are hashed. Entries come in an order where a folder precedes what is in it.
 */
export const scanBundle = async (root: string): Promise<TreeEntry[]> => {
  const found: TreeEntry[] = [];
  const visit = async (relative: string): Promise<void> => {
    const names = (await readdir(join(root, relative))).sort();
    for (const name of names) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) {
        found.push({ path, kind: "link", target: await readlink(join(root, path)) });
      } else if (stat.isDirectory()) {
        found.push({ path, kind: "dir" });
        await visit(path);
      } else if (stat.isFile()) {
        found.push({
          path,
          kind: "file",
          mode: stat.mode & 0o777,
          size: stat.size,
          sha256: await hashOf(join(root, path)),
        });
      } else throw new Error(`${path} is neither a file, a folder nor a link`);
    }
  };
  await visit("");
  return found;
};

/** Reads a stream of chunks as a sequence of bytes: to skip, to read a few, to hand on a stretch. */
class ByteReader {
  readonly #chunks: AsyncIterator<Uint8Array>;
  #chunk: Uint8Array = new Uint8Array(0);
  /** How many bytes have been taken from the front so far. */
  position = 0;
  readonly #onRead: (bytes: number) => void;

  constructor(source: AsyncIterable<Uint8Array>, onRead: (bytes: number) => void) {
    this.#chunks = source[Symbol.asyncIterator]();
    this.#onRead = onRead;
  }

  async #more(): Promise<void> {
    while (this.#chunk.length === 0) {
      const next = await this.#chunks.next();
      if (next.done) throw new Error("The download ended before the file did.");
      this.#chunk = next.value;
      this.#onRead(next.value.length);
    }
  }

  async skip(count: number): Promise<void> {
    let left = count;
    while (left > 0) {
      await this.#more();
      const take = Math.min(left, this.#chunk.length);
      this.#chunk = this.#chunk.subarray(take);
      left -= take;
      this.position += take;
    }
  }

  async read(count: number): Promise<Uint8Array> {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      await this.#more();
      const take = Math.min(count - filled, this.#chunk.length);
      out.set(this.#chunk.subarray(0, take), filled);
      this.#chunk = this.#chunk.subarray(take);
      filled += take;
      this.position += take;
    }
    return out;
  }

  async *take(count: number): AsyncGenerator<Uint8Array> {
    let left = count;
    while (left > 0) {
      await this.#more();
      const take = Math.min(left, this.#chunk.length);
      const piece = this.#chunk.subarray(0, take);
      this.#chunk = this.#chunk.subarray(take);
      left -= take;
      this.position += take;
      yield piece;
    }
  }

  async close(): Promise<void> {
    await this.#chunks.return?.();
  }
}

export type DeltaOptions = {
  /** The installed bundle, `Cycle.app`. */
  installed: string;
  /** Where the new bundle is made: it is `<into>/Cycle.app`. */
  into: string;
  /** The release's archive, and its size (the manifest's). */
  archiveUrl: string;
  archiveSize: number;
  tree: readonly TreeEntry[];
  /** A GET that follows redirects and throws for a network that limits requests. */
  get: (url: string, headers: Record<string, string>) => Promise<Response>;
  /** Called once what has to be fetched is known; `total` is a count of bytes to be read from the network. */
  onPlan: (total: number) => void;
  onProgress: (received: number, total: number) => void;
  log?: ((message: string) => void) | undefined;
};

export type DeltaResult = { app: string; fetched: number; reused: number; changed: number };

type Wanted = { entry: TreeEntry & { kind: "file" }; zip: ZipEntry };
type Group = { start: number; end: number; items: Wanted[] };

/** What a bundle's entry is called in the archive: the bundle's own folder is its first part. */
const entryName = (path: string): string => `${MAC_BUNDLE}/${path}`;

const rangeOf = async (options: DeltaOptions, start: number, end: number): Promise<Response> => {
  const response = await options.get(options.archiveUrl, { range: `bytes=${start}-${end}` });
  if (response.status !== 206 || response.body === null) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`The server did not answer a range request with a range (${response.status}).`);
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  if (
    match === null ||
    Number(match[1]) !== start ||
    Number(match[2]) !== end ||
    Number(match[3]) !== options.archiveSize
  ) {
    await response.body.cancel().catch(() => {});
    throw new Error("The server's range is not the one asked for.");
  }
  return response;
};

const bodyOf = async (options: DeltaOptions, start: number, end: number): Promise<Uint8Array> => {
  const response = await rangeOf(options, start, end);
  const bytes = new Uint8Array(end - start + 1);
  let filled = 0;
  for await (const chunk of Readable.fromWeb(response.body as never) as AsyncIterable<Uint8Array>) {
    if (filled + chunk.length > bytes.length)
      throw new Error("The server sent more than asked for.");
    bytes.set(chunk, filled);
    filled += chunk.length;
  }
  if (filled !== bytes.length) throw new Error("The server sent less than asked for.");
  return bytes;
};

/** The archive's directory, read from the end of the archive with one or two requests. */
const readDirectory = async (options: DeltaOptions): Promise<Map<string, ZipEntry>> => {
  const size = options.archiveSize;
  const tailStart = Math.max(0, size - END_SEARCH - 512 * 1024);
  const tail = await bodyOf(options, tailStart, size - 1);
  const end = parseEnd(tail);
  let directory: Uint8Array;
  if (end.directoryOffset >= tailStart) {
    directory = tail.subarray(
      end.directoryOffset - tailStart,
      end.directoryOffset - tailStart + end.directorySize,
    );
  } else {
    directory = await bodyOf(
      options,
      end.directoryOffset,
      end.directoryOffset + end.directorySize - 1,
    );
  }
  if (directory.length !== end.directorySize)
    throw new Error("The archive's directory is damaged.");
  return parseDirectory(directory, end.entries);
};

/** Wanted files, in the order they sit in the archive, as the requests that fetch them. */
const grouped = (wanted: Wanted[], archiveSize: number): Group[] => {
  const sorted = [...wanted].sort((a, b) => a.zip.offset - b.zip.offset);
  const groups: Group[] = [];
  for (const item of sorted) {
    // Everything of the entry is within its header, the room for an extra field, and its data.
    const end = Math.min(
      archiveSize - 1,
      item.zip.offset + LOCAL_HEADER + item.zip.nameLength + HEADER_ROOM + item.zip.csize - 1,
    );
    const last = groups.at(-1);
    const small = item.zip.csize <= SMALL && last?.items.every((i) => i.zip.csize <= SMALL);
    if (
      last !== undefined &&
      small &&
      item.zip.offset - last.end <= GAP &&
      end - last.start < GROUP_MAX
    ) {
      last.items.push(item);
      last.end = Math.max(last.end, end);
    } else groups.push({ start: item.zip.offset, end, items: [item] });
  }
  return groups;
};

/** Makes the new bundle. Throws `DeltaDeclined` when fetching the difference is not worth it. */
export const assembleDelta = async (options: DeltaOptions): Promise<DeltaResult> => {
  const { installed, tree } = options;
  const app = join(options.into, MAC_BUNDLE);
  await rm(app, { recursive: true, force: true });
  await mkdir(app, { recursive: true });

  // The folders and links, and every file the installed bundle already has (hashed where it is used).
  const files = tree.filter(
    (entry): entry is TreeEntry & { kind: "file" } => entry.kind === "file",
  );
  for (const entry of tree) {
    if (entry.kind === "dir") await mkdir(join(app, entry.path), { mode: 0o755 });
    else if (entry.kind === "link") await symlink(entry.target, join(app, entry.path));
  }
  const missing: (TreeEntry & { kind: "file" })[] = [];
  let reused = 0;
  await pool(files, PARALLEL, async (entry) => {
    const from = join(installed, entry.path);
    const to = join(app, entry.path);
    // lstat: a link in the installed bundle is not a file to take, whatever it points at.
    const stat = await lstat(from).catch(() => undefined);
    if (stat?.isFile() === true && stat.size === entry.size) {
      await copyFile(from, to, constants.COPYFILE_FICLONE);
      if ((await hashOf(to)) === entry.sha256) {
        await chmod(to, entry.mode);
        reused += 1;
        return;
      }
      await rm(to, { force: true });
    }
    missing.push(entry);
  });

  // Where the rest is in the archive.
  const directory = missing.length > 0 ? await readDirectory(options) : new Map<string, ZipEntry>();
  const wanted: Wanted[] = missing.map((entry) => {
    const zip = directory.get(entryName(entry.path));
    if (zip === undefined) throw new Error(`The archive has no ${entry.path}.`);
    if (zip.method !== 0 && zip.method !== 8)
      throw new Error(`The archive stores ${entry.path} in a way the updater does not read.`);
    if (zip.size !== entry.size)
      throw new Error(`The archive's ${entry.path} is not the size the file table says.`);
    return { entry, zip };
  });
  const groups = grouped(wanted, options.archiveSize);
  const total = groups.reduce((sum, group) => sum + (group.end - group.start + 1), 0);
  if (total > options.archiveSize * WORTH_IT)
    throw new DeltaDeclined(`fetching the difference (${total} bytes) is not worth it`);
  options.onPlan(total);

  let received = 0;
  await pool(groups, PARALLEL, async (group) => {
    const response = await rangeOf(options, group.start, group.end);
    const reader = new ByteReader(
      Readable.fromWeb(response.body as never) as AsyncIterable<Uint8Array>,
      (bytes) => {
        received += bytes;
        options.onProgress(Math.min(received, total), total);
      },
    );
    try {
      for (const { entry, zip } of group.items) {
        await reader.skip(zip.offset - group.start - reader.position);
        const local = parseLocal(await reader.read(LOCAL_HEADER));
        if (local.nameLength !== zip.nameLength || local.extraLength > HEADER_ROOM)
          throw new Error(`The archive's header for ${entry.path} is not as its directory says.`);
        await reader.skip(local.nameLength + local.extraLength);
        await writeEntry(join(app, entry.path), entry, zip, reader);
      }
    } finally {
      await reader.close().catch(() => {});
    }
  });
  options.onProgress(total, total);

  await checkShape(app, tree);
  return { app, fetched: total, reused, changed: missing.length };
};

/** Streams one file's data out of the archive into place, checking its size and SHA-256 on the way. */
const writeEntry = async (
  to: string,
  entry: TreeEntry & { kind: "file" },
  zip: ZipEntry,
  reader: ByteReader,
): Promise<void> => {
  const hash = createHash("sha256");
  let written = 0;
  const check = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      written += chunk.length;
      // Not more than the table says, so that a damaged archive cannot fill the disk.
      if (written > entry.size)
        throw new Error(`${entry.path} is larger than the file table says.`);
      hash.update(chunk);
      yield chunk;
    }
  };
  const data = reader.take(zip.csize);
  const out = createWriteStream(to, { flags: "wx" });
  if (zip.method === 8) await pipeline(data, createInflateRaw(), check, out);
  else await pipeline(data, check, out);
  if (written !== entry.size || hash.digest("hex") !== entry.sha256)
    throw new Error(`${entry.path} does not match the file table.`);
  await chmod(to, entry.mode);
};

/** The new bundle holds exactly what the table lists: nothing missing, nothing else, links and modes as said. */
const checkShape = async (root: string, tree: readonly TreeEntry[]): Promise<void> => {
  const expected = new Map(tree.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  const visit = async (relative: string): Promise<void> => {
    for (const name of await readdir(join(root, relative))) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const entry = expected.get(path);
      if (entry === undefined)
        throw new Error(`The assembled bundle has ${path}, which is not listed.`);
      const stat = await lstat(join(root, path));
      seen.add(path);
      if (entry.kind === "dir") {
        if (!stat.isDirectory()) throw new Error(`${path} should be a folder.`);
        await visit(path);
      } else if (entry.kind === "link") {
        if (!stat.isSymbolicLink() || (await readlink(join(root, path))) !== entry.target)
          throw new Error(`${path} should be a link to ${entry.target}.`);
      } else if (!stat.isFile() || stat.size !== entry.size || (stat.mode & 0o777) !== entry.mode) {
        throw new Error(`${path} is not as the file table says.`);
      }
    }
  };
  await visit("");
  if (seen.size !== expected.size)
    throw new Error("The assembled bundle lacks files the table lists.");
};
