import { z } from "zod";
import { cycleMethod } from "./method.ts";

/**
 * What the Diff tab's workspace view may ask of a session's folder (docs/protocol.md §8 "工作区的改动"): which files
 * differ from `HEAD`, and one file's patch, computed by git in a trusted repository.
 */
export const DIFF_LIMITS = {
  /** Files listed. */
  files: 1_000,
  /** Bytes of one patch, and of an untracked file whose lines are counted. */
  patch: 1024 * 1024,
} as const;

export const DiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "untracked"]),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  binary: z.boolean().optional(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const DiffStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ok"),
    /** The commit compared with; null before the first one (compared with nothing). */
    head: z.string().nullable(),
    files: z.array(DiffFileSchema),
    truncated: z.boolean(),
  }),
  z.object({ state: z.literal("not_git") }),
  z.object({ state: z.literal("untrusted"), repository: z.string() }),
]);
export type DiffStatus = z.infer<typeof DiffStatusSchema>;

export const diffStatus = cycleMethod(
  "_cycle/diff/status",
  z.object({ sessionId: z.string() }),
  DiffStatusSchema,
);

export const DiffPatchSchema = z.object({
  path: z.string(),
  patch: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
});
export type DiffPatch = z.infer<typeof DiffPatchSchema>;

export const diffFile = cycleMethod(
  "_cycle/diff/file",
  z.object({ sessionId: z.string(), path: z.string().max(4096) }),
  DiffPatchSchema,
);
