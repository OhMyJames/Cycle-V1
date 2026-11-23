import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

/** The `sessionUpdate` of a background task that is not a sub-agent (docs/protocol.md §9, CYCL-87). */
export const TASK_UPDATE = "_cycle/task_update";

/** The `sessionUpdate` of the session's goal (docs/protocol.md §9, CYCL-87). */
export const GOAL_UPDATE = "_cycle/goal_update";

type Kind = "shell" | "monitor" | "workflow" | "mcp" | "other";
type State = "running" | "completed" | "failed" | "stopped" | "unknown";

type Task = {
  task_id?: unknown;
  run_id?: string;
  tool_use_id?: string;
  task_type?: string;
  description?: string;
  parent_task_id?: string;
  status?: string;
  patch?: { status?: string; description?: string };
  ambient?: boolean;
  skip_transcript?: boolean;
};

/** The SDK's `task_type` as one of the protocol's words. Only `local_agent` is a sub-agent, told elsewhere. */
export const kindOf = (taskType: string | undefined): Kind => {
  const type = taskType ?? "";
  if (/bash|shell/.test(type)) return "shell";
  if (/monitor/.test(type)) return "monitor";
  if (/workflow/.test(type)) return "workflow";
  if (/mcp/.test(type)) return "mcp";
  return "other";
};

const endOf = (status: string | undefined): State | undefined => {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "stopped" || status === "killed") return "stopped";
  return undefined;
};

/** Not activity: housekeeping and the watchers Claude Code starts by itself (SDK: `ambient`, `skip_transcript`). */
const quiet = (task: Task) => task.ambient === true || task.skip_transcript === true;

/**
 * The SDK's `task_*` messages and its background list, for the tasks that are not sub-agents: a background command, a
 * watcher, a workflow, an MCP server's task. Each is announced with its kind, and told again when it ends, or when it
 * leaves the list with no end (`unknown`). Announcement only: nothing here stops a task.
 */
export class BackgroundTasks {
  readonly #known = new Map<string, { run: string | undefined; unknown: boolean }>();
  /** Tasks told as ended, with the run that ended: a list that lags behind the end must not bring them back. */
  readonly #ended = new Map<string, string | undefined>();

  /** A task told as running, not lost: the process must stay up for it (a command, a watcher). */
  get hasRunning(): boolean {
    return [...this.#known.values()].some((task) => !task.unknown);
  }

  #end(id: string, run: string | undefined): void {
    this.#known.delete(id);
    this.#ended.set(id, run);
  }

  /** The SDK sends the whole list after each change. A task gone from it with no end is unknown, not finished. */
  reconcile(tasks: readonly Task[]): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    const live = new Set<string>();
    for (const task of tasks) {
      // Every entry of the list names its type (SDK); one that does not is not known to be ours to tell.
      if (
        typeof task.task_id !== "string" ||
        task.task_type === undefined ||
        task.task_type === "local_agent" ||
        quiet(task)
      )
        continue;
      const ended = this.#ended.get(task.task_id);
      if (
        this.#ended.has(task.task_id) &&
        (!task.run_id || ended === undefined || task.run_id <= ended)
      )
        continue;
      live.add(task.task_id);
      const known = this.#known.get(task.task_id);
      if (known?.run && task.run_id && task.run_id < known.run) continue;
      if (known !== undefined && !known.unknown && (!task.run_id || known.run === task.run_id))
        continue;
      this.#known.set(task.task_id, { run: task.run_id ?? known?.run, unknown: false });
      updates.push(this.#make(task.task_id, "running", task));
    }
    for (const [id, known] of this.#known) {
      if (known.unknown || live.has(id)) continue;
      known.unknown = true;
      updates.push(this.#make(id, "unknown"));
    }
    return updates;
  }

  /**
   * One `task_*` message. `toolName` says which tool a call is: a Monitor's task is `local_bash` like any background
   * command (SDK 0.3.327), and only the call that started it tells the two apart.
   */
  update(
    message: { subtype: string } & Record<string, unknown>,
    toolName?: (toolUseId: string) => string | undefined,
  ): SessionUpdate | undefined {
    const task = message as Task;
    if (typeof task.task_id !== "string") return undefined;
    const id = task.task_id;
    const known = this.#known.get(id);
    if (known?.run && task.run_id && task.run_id < known.run) return undefined;
    if (message.subtype === "task_started") {
      if (task.task_type === undefined || task.task_type === "local_agent" || quiet(task))
        return undefined;
      this.#known.set(id, { run: task.run_id ?? known?.run, unknown: false });
      this.#ended.delete(id);
      const monitor = task.tool_use_id !== undefined && toolName?.(task.tool_use_id) === "Monitor";
      return this.#make(id, "running", task, monitor ? "monitor" : undefined);
    }
    if (known === undefined || (known.run && task.run_id && known.run !== task.run_id))
      return undefined;
    if (message.subtype === "task_notification") {
      const end = endOf(task.status);
      if (end === undefined) return undefined;
      this.#end(id, known.run);
      return this.#make(id, end);
    }
    if (message.subtype === "task_updated") {
      const end = endOf(task.patch?.status);
      if (end !== undefined) {
        this.#end(id, known.run);
        return this.#make(id, end);
      }
      if (task.patch?.description === undefined) return undefined;
      known.unknown = false;
      return this.#make(id, "running", { description: task.patch.description });
    }
    if (message.subtype === "task_progress" && known.unknown) {
      known.unknown = false;
      return this.#make(id, "running");
    }
    return undefined;
  }

  /** The process is gone, and the tasks it ran with it. */
  endAll(): SessionUpdate[] {
    const updates = [...this.#known.entries()]
      .filter(([, task]) => !task.unknown)
      .map(([id]) => this.#make(id, "stopped"));
    this.#known.clear();
    return updates;
  }

  #make(taskId: string, state: State, task?: Task, kind?: Kind): SessionUpdate {
    return {
      sessionUpdate: TASK_UPDATE,
      taskId,
      ...(kind !== undefined
        ? { kind }
        : task?.task_type !== undefined
          ? { kind: kindOf(task.task_type) }
          : {}),
      ...(task?.description ? { title: task.description } : {}),
      ...(task?.tool_use_id !== undefined ? { toolCallId: task.tool_use_id } : {}),
      ...(task?.parent_task_id !== undefined ? { parentId: task.parent_task_id } : {}),
      state,
    } as unknown as SessionUpdate;
  }
}

/** The SDK's `active_goal` as the protocol's goal: the same fields, in its words. Undefined when it is not one. */
export const goalUpdateOf = (message: unknown): SessionUpdate | undefined => {
  const value = (message as { value?: unknown }).value;
  if (value === null) return { sessionUpdate: GOAL_UPDATE, goal: null } as unknown as SessionUpdate;
  if (typeof value !== "object" || value === undefined) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.condition !== "string") return undefined;
  return {
    sessionUpdate: GOAL_UPDATE,
    goal: {
      condition: v.condition,
      iterations:
        typeof v.iterations === "number" && v.iterations >= 0 ? Math.floor(v.iterations) : 0,
      setAt: typeof v.set_at === "number" ? v.set_at : 0,
      ...(typeof v.last_reason === "string" && v.last_reason !== ""
        ? { lastReason: v.last_reason }
        : {}),
    },
  } as unknown as SessionUpdate;
};
