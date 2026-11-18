import { z } from "zod";
import { cycleMethod } from "./method.ts";

const SessionId = z.string();

export const DoneSchema = z.object({});

/** What a daemon knows of an agent it can run. `configSchema` is JSON Schema. */
export const AgentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
  configSchema: z.record(z.string(), z.unknown()),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const agentsList = cycleMethod(
  "_cycle/agents/list",
  z.object({}),
  z.object({ agents: z.array(AgentInfoSchema) }),
);

export const agentDefaultsRead = cycleMethod(
  "_cycle/agent_defaults/read",
  z.object({ agent: z.string() }),
  z.object({ config: z.record(z.string(), z.unknown()) }),
);

export const agentDefaultsSet = cycleMethod(
  "_cycle/agent_defaults/set",
  z.object({ agent: z.string(), config: z.record(z.string(), z.unknown()) }),
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
