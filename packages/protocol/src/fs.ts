import { z } from "zod";
import { cycleMethod } from "./method.ts";

/**
 * What the Files tab may ask of a session's folder (docs/protocol.md §8 "浏览和预览文件"): one folder at a time, a file
 * a piece at a time, always inside the session's `cwd`.
 */
export const FS_LIMITS = {
  /** Entries of one folder looked at, and given. */
  examined: 20_000,
  entries: 5_000,
  /** Bytes of text in one read. */
  textChunk: 1024 * 1024,
  /** Bytes looked at to tell text from binary. */
  sniff: 8 * 1024,
  /** Bytes of an image given whole. */
  image: 10 * 1024 * 1024,
} as const;

/** A path inside the session's `cwd`, relative to it, `/`-separated; `""` is the `cwd` itself. */
const RelativePath = z.string().max(4096);

export const FsEntrySchema = z.object({
  name: z.string(),
  /** `other`: a link out of the folder or to nothing, a device, a pipe: listed, never opened. */
  kind: z.enum(["file", "folder", "other"]),
  /** A symbolic link; `kind` is what it leads to. */
  link: z.boolean().optional(),
  /** Bytes; files only. */
  size: z.number().int().nonnegative().optional(),
  /** Ignored by git. Given only in a trusted folder in a repository; absent is "not known", not "not ignored". */
  ignored: z.boolean().optional(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsListSchema = z.object({
  root: z.string(),
  path: z.string(),
  entries: z.array(FsEntrySchema),
  truncated: z.boolean(),
});
export type FsList = z.infer<typeof FsListSchema>;

export const fsList = cycleMethod(
  "_cycle/fs/list",
  z.object({ sessionId: z.string(), path: RelativePath }),
  FsListSchema,
);

const FileHead = { path: z.string(), size: z.number().int().nonnegative(), mtimeMs: z.number() };

export const FsReadSchema = z.discriminatedUnion("kind", [
  z.object({
    ...FileHead,
    kind: z.literal("text"),
    text: z.string(),
    offset: z.number().int().nonnegative(),
    /** Where the next piece starts; null at the end. */
    next: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    ...FileHead,
    kind: z.literal("image"),
    mimeType: z.string(),
    /** Base64; absent when the image is over `FS_LIMITS.image`. */
    data: z.string().optional(),
    tooLarge: z.boolean().optional(),
  }),
  z.object({ ...FileHead, kind: z.literal("binary") }),
]);
export type FsRead = z.infer<typeof FsReadSchema>;

export const fsRead = cycleMethod(
  "_cycle/fs/read",
  z.object({
    sessionId: z.string(),
    path: RelativePath,
    offset: z.number().int().nonnegative().optional(),
  }),
  FsReadSchema,
);
