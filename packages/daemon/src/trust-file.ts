import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { Trust } from "@cycle/protocol";
import { z } from "zod";
import { INVALID_PARAMS, RESOURCE_NOT_FOUND, RpcError } from "./errors.ts";

const TrustFileSchema = z.object({
  version: z.literal(1),
  folders: z.record(z.string(), z.boolean()),
});

/** The trust file is there but cannot be read. It is not replaced. */
export class TrustUnreadableError extends Error {
  constructor(path: string, detail: string) {
    super(
      `The folder trust at ${path} cannot be read (${detail}). Fix or move it; it is not replaced.`,
    );
    this.name = "TrustUnreadableError";
  }
}

/** Whether `path` is `folder` or inside it. Both are real, absolute paths. */
export const within = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);

/**
 * The real path of a folder a client names: absolute, there, and a folder. Errors as
 * docs/protocol.md §8 "信任文件夹" says.
 */
export const realFolder = async (path: string): Promise<string> => {
  if (path.includes("\0")) throw new RpcError(INVALID_PARAMS, "The path is not valid", {});
  if (!isAbsolute(path)) throw new RpcError(INVALID_PARAMS, "The path must be absolute", { path });
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new RpcError(RESOURCE_NOT_FOUND, "No such folder", { path });
    throw new RpcError(INVALID_PARAMS, "That is not a folder", { path, reason: "not_a_folder" });
  }
  const isFolder = await stat(real).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isFolder)
    throw new RpcError(INVALID_PARAMS, "That is not a folder", { path, reason: "not_a_folder" });
  return real;
};

/**
 * Which folders may run the commands their own configuration names (docs/protocol.md §8
 * "信任文件夹"): real path to true or false; a folder with no entry has no decision. A decision
 * covers the folders under it; the nearest one wins. Written whole, to a temporary file and then
 * renamed, like the session index.
 */
export class FolderTrust {
  readonly #path: string;
  #folders: Map<string, boolean>;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, folders: Map<string, boolean>) {
    this.#path = path;
    this.#folders = folders;
  }

  static async load(path: string): Promise<FolderTrust> {
    const file = Bun.file(path);
    if (!(await file.exists())) return new FolderTrust(path, new Map());
    try {
      const parsed = TrustFileSchema.parse(JSON.parse(await file.text()));
      return new FolderTrust(path, new Map(Object.entries(parsed.folders)));
    } catch (error) {
      throw new TrustUnreadableError(path, error instanceof Error ? error.message : String(error));
    }
  }

  /** The decision for a real path: its own, else the nearest folder above it with one. */
  of(real: string): Trust {
    for (let at = real; ; at = dirname(at)) {
      const trusted = this.#folders.get(at);
      if (trusted !== undefined) return { path: real, trusted, from: at };
      if (dirname(at) === at) return { path: real, trusted: null, from: null };
    }
  }

  set(real: string, trusted: boolean): Promise<Trust> {
    const run = this.#queue.then(async () => {
      const before = new Map(this.#folders);
      try {
        this.#folders.set(real, trusted);
        await mkdir(dirname(this.#path), { recursive: true });
        const temporary = `${this.#path}.${process.pid}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify({ version: 1, folders: Object.fromEntries(this.#folders) }, null, 2)}\n`,
        );
        await rename(temporary, this.#path);
      } catch (error) {
        this.#folders = before;
        throw error;
      }
      return this.of(real);
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
