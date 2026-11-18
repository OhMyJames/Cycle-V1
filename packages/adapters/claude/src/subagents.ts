import type { SessionUpdate } from "@cycle/acp";

/** In a `subagent_update`'s `_meta`: what the SDK says of the task beyond what ACP has a field for (decision 0013). */
export const SUBAGENT_META = "cycle/subagent";

type Task = {
  task_id: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  summary?: string;
  last_tool_name?: string;
  is_backgrounded?: boolean;
  parent_task_id?: string;
  task_type?: string;
  status?: string;
  patch?: { status?: string; description?: string; is_backgrounded?: boolean; error?: string };
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  ambient?: boolean;
  skip_transcript?: boolean;
};

type Ended = { stopReason: "end_turn" | "cancelled" } | { stopReason: "error"; error: unknown };

/** How a task's end is told as a state: ACP's idle, with the reason it stopped. */
const endOf = (status: string | undefined, why: string | undefined): Ended | undefined => {
  if (status === "completed") return { stopReason: "end_turn" };
  if (status === "stopped" || status === "killed") return { stopReason: "cancelled" };
  if (status === "failed") {
    return { stopReason: "error", error: { code: -32603, message: why || "The sub-agent failed" } };
  }
  return undefined;
};

/**
 * The SDK's `task_*` messages as ACP `subagent_update`s: a sub-agent the model started (the Agent
 * tool) is announced, reports progress, and ends. Announcement only: the sub-agent's own transcript
 * is not routed, so the child's id is the task's and no client can open it as a session.
 *
 * A task that is not an agent (a background shell, a watcher, a task that is only housekeeping) is
 * not a sub-agent and is left out. Progress is only for a task that was announced.
 */
export class Subagents {
  /** The tool call each announced task came from: later messages do not always say. */
  readonly #known = new Map<string, string | undefined>();

  update(message: { subtype: string } & Record<string, unknown>): SessionUpdate | undefined {
    const task = message as unknown as Task;
    if (typeof task.task_id !== "string") return undefined;
    if (message.subtype === "task_started") {
      const agent = task.task_type === undefined || task.task_type === "local_agent";
      if (!agent || task.ambient === true || task.skip_transcript === true) return undefined;
      this.#known.set(task.task_id, task.tool_use_id);
      return this.#make(task, { state: "running" }, task.description);
    }
    if (!this.#known.has(task.task_id)) return undefined;
    if (message.subtype === "task_progress") {
      return this.#make(task, { state: "running" }, task.description);
    }
    if (message.subtype === "task_notification") {
      const end = endOf(task.status, task.summary);
      if (end === undefined) return undefined;
      const update = this.#make(task, { state: "idle", ...end });
      this.#known.delete(task.task_id);
      return update;
    }
    if (message.subtype === "task_updated") {
      const patch = task.patch ?? {};
      const end = endOf(patch.status, patch.error);
      if (end === undefined && patch.description === undefined) return undefined;
      const update = this.#make(
        task,
        end ? { state: "idle", ...end } : undefined,
        patch.description,
      );
      if (end !== undefined) this.#known.delete(task.task_id);
      return update;
    }
    return undefined;
  }

  /** The process is gone: the sub-agents that were running are over. */
  endAll(): SessionUpdate[] {
    const updates = [...this.#known.keys()].map((id) =>
      this.#make({ task_id: id }, { state: "idle", stopReason: "cancelled" }),
    );
    this.#known.clear();
    return updates;
  }

  #make(task: Task, state: object | undefined, title?: string): SessionUpdate {
    const meta: Record<string, unknown> = {};
    const toolCallId = task.tool_use_id ?? this.#known.get(task.task_id);
    if (toolCallId !== undefined) meta.toolCallId = toolCallId;
    if (task.is_backgrounded !== undefined) meta.background = task.is_backgrounded;
    if (task.parent_task_id !== undefined) meta.parentId = task.parent_task_id;
    if (task.summary !== undefined && task.status === undefined) meta.summary = task.summary;
    if (task.last_tool_name !== undefined) meta.lastTool = task.last_tool_name;
    if (task.usage !== undefined) {
      meta.usage = {
        tokens: task.usage.total_tokens ?? 0,
        toolUses: task.usage.tool_uses ?? 0,
        durationMs: task.usage.duration_ms ?? 0,
      };
    }
    return {
      sessionUpdate: "subagent_update",
      sessionId: task.task_id,
      ...(title ? { title } : {}),
      ...(task.subagent_type ? { description: task.subagent_type } : {}),
      ...(state ? { state } : {}),
      _meta: { [SUBAGENT_META]: meta },
    } as SessionUpdate;
  }
}
