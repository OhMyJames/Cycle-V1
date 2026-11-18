import { z } from "zod";
import { cycleMethod } from "./method.ts";
import { PromptCapabilitiesSchema } from "./prompt.ts";

const SessionId = z.string();

export const DoneSchema = z.object({});

/** What a daemon knows of an agent it can run. `configSchema` is JSON Schema. */
export const AgentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
  configSchema: z.record(z.string(), z.unknown()),
  /** What the agent takes in a prompt beyond text and links (decision 0010). Absent: nothing more. */
  promptCapabilities: PromptCapabilitiesSchema.optional(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const agentsList = cycleMethod(
  "_cycle/agents/list",
  z.object({}),
  z.object({ agents: z.array(AgentInfoSchema) }),
);

/** What a session of an agent is configured with: setting by name, each a string. */
export const AgentConfigSchema = z.record(z.string(), z.string());

export const agentDefaultsRead = cycleMethod(
  "_cycle/agent_defaults/read",
  z.object({ agent: z.string() }),
  z.object({ config: AgentConfigSchema }),
);

export const agentDefaultsSet = cycleMethod(
  "_cycle/agent_defaults/set",
  z.object({ agent: z.string(), config: AgentConfigSchema }),
  DoneSchema,
);

export const sessionArchive = cycleMethod(
  "_cycle/session/archive",
  z.object({ sessionId: SessionId }),
  DoneSchema,
);

export const sessionUnarchive = cycleMethod(
  "_cycle/session/unarchive",
  z.object({ sessionId: SessionId }),
  DoneSchema,
);

/** Until ACP's `session/set_title` leaves unstable. */
export const sessionSetTitle = cycleMethod(
  "_cycle/session/set_title",
  z.object({ sessionId: SessionId, title: z.string().min(1) }),
  DoneSchema,
);

/** What `_cycle/files/search` finds (docs/protocol.md §8): paths, never contents. */
export const FileEntrySchema = z.object({ path: z.string(), kind: z.enum(["file", "folder"]) });
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const filesSearch = cycleMethod(
  "_cycle/files/search",
  z.object({
    sessionId: SessionId,
    query: z.string().max(200),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({ root: z.string(), entries: z.array(FileEntrySchema), truncated: z.boolean() }),
);

/** What `_cycle/folders/list` gives (docs/protocol.md §8): the names of folders, never files or contents. */
export const foldersList = cycleMethod(
  "_cycle/folders/list",
  z.object({
    /** Absolute. Absent: the daemon's user's home. */
    path: z.string().min(1).max(4096).optional(),
    /** Names that start with a dot are given only when asked for. */
    hidden: z.boolean().optional(),
  }),
  z.object({
    /** The real path (links resolved) of what was listed. */
    path: z.string(),
    /** One level up; null at the root. */
    parent: z.string().nullable(),
    home: z.string(),
    folders: z.array(z.object({ name: z.string() })),
    truncated: z.boolean(),
  }),
);

/**
 * Says the client has seen the session up to `seq`. `readSeq` only moves forward; `seq` beyond the
 * session's last record is refused. See docs/protocol.md §6 "已读".
 */
export const sessionMarkRead = cycleMethod(
  "_cycle/session/mark_read",
  z.object({ sessionId: SessionId, seq: z.number().int().nonnegative() }),
  DoneSchema,
);

/** Notifications the daemon sends. */
export const sessionListChanged = z.object({});

export const requestResolved = z.object({
  sessionId: SessionId,
  requestId: z.union([z.string(), z.number()]),
  /** What settled it: the chosen outcome, or why it was aborted. */
  outcome: z.unknown(),
});
export const NOTIFICATIONS = {
  sessionListChanged: "_cycle/session_list_changed",
  requestResolved: "_cycle/request_resolved",
  agentDefaultsChanged: "_cycle/agent_defaults_changed",
} as const;
