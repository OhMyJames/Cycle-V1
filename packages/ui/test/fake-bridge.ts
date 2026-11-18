import type { SessionUpdate } from "@cycle/acp";
import type {
  AppEvent,
  ConnectionState,
  CycleBridge,
  EnvironmentConfig,
  SessionSnapshot,
  SessionSummary,
  UpdateState,
} from "../src/api.ts";
import { emptyConversation } from "../src/model/index.ts";

export const LOCAL: EnvironmentConfig = { id: "local", name: "This computer", kind: "local" };
export const summary = (sessionId: string, environmentId = "local"): SessionSummary => ({
  environmentId,
  sessionId,
  cwd: "/work",
  archived: false,
  agent: "fake",
  state: "idle",
  lastSeq: 0,
  // This computer's is the newer, so that it is the workspace shown unless a test says otherwise.
  updatedAt: environmentId === "local" ? "2020-01-02T00:00:00.000Z" : "2020-01-01T00:00:00.000Z",
});
export const text = (t: string, id = "a") =>
  ({
    sessionUpdate: "agent_message_chunk",
    messageId: id,
    content: { type: "text", text: t },
  }) as SessionUpdate;
export const idle = (extra: object = {}) =>
  ({ sessionUpdate: "state_update", state: "idle", ...extra }) as SessionUpdate;

/** A bridge that records what it is asked, answers from a script, and lets a test send events. */
export const fakeBridge = (
  options: {
    snapshot?: () => SessionSnapshot | Promise<SessionSnapshot>;
    connected?: boolean;
    update?: UpdateState;
    /** What the daemon says it can do. Default: all of it. */
    capabilities?: { queue: boolean; files: boolean; folders: boolean };
    /** More environments than the local one, and how each stands (by id; the local one's is `connected`). */
    environments?: EnvironmentConfig[];
    states?: Record<string, ConnectionState>;
  } = {},
) => {
  const calls: [string, ...unknown[]][] = [];
  let listener: ((event: AppEvent) => void) | undefined;
  const record =
    <A extends unknown[], R>(name: string, result: (...args: A) => R) =>
    (...args: A): R => {
      calls.push([name, ...args]);
      return result(...args);
    };
  const bridge: CycleBridge = {
    onEvent: (l) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    environments: record("environments", async () => {
      const environments = [LOCAL, ...(options.environments ?? [])];
      return {
        environments,
        status: environments.map((h) => {
          const state =
            options.states?.[h.id] ?? (options.connected === false ? "closed" : "connected");
          return {
            environmentId: h.id,
            state,
            ...(state === "connected"
              ? {
                  capabilities: options.capabilities ?? { queue: true, files: true, folders: true },
                }
              : {}),
          };
        }),
        // What main has read of each environment, through the same call a test may replace to say what a list holds.
        sessions: Object.fromEntries(
          await Promise.all(
            environments.map(async (h) => [h.id, await bridge.sessions(h.id)] as const),
          ),
        ),
      };
    }),
    saveEnvironment: record("saveEnvironment", async () => {}),
    removeEnvironment: record("removeEnvironment", async () => {}),
    connect: record("connect", async () => {}),
    disconnect: record("disconnect", async () => {}),
    sessions: record("sessions", async (environmentId: string) => [summary("s1", environmentId)]),
    createSession: record("createSession", async () => "s2"),
    openSession: record(
      "openSession",
      async () =>
        (await options.snapshot?.()) ?? {
          conversation: emptyConversation(),
          permissions: [],
          version: 0,
        },
    ),
    prompt: record("prompt", async () => {}),
    cancel: record("cancel", async () => {}),
    dequeue: record("dequeue", async () => []),
    listFolders: record("listFolders", async () => ({
      path: "/home/me",
      parent: "/home",
      home: "/home/me",
      folders: [{ name: "app" }, { name: "docs" }],
      truncated: false,
    })),
    searchFiles: record("searchFiles", async () => ({
      root: "/work",
      entries: [],
      truncated: false,
    })),
    setSessionConfig: record("setSessionConfig", async () => {}),
    renameSession: record("renameSession", async () => {}),
    archiveSession: record("archiveSession", async () => {}),
    markRead: record("markRead", async () => {}),
    deleteSession: record("deleteSession", async () => {}),
    answerPermission: record("answerPermission", async () => {}),
    agents: record("agents", async () => [
      { id: "fake", name: "Fake", available: true, configSchema: {} },
    ]),
    agentDefaults: record("agentDefaults", async () => ({})),
    setAgentDefaults: record("setAgentDefaults", async () => {}),
    chooseDirectory: record("chooseDirectory", async () => "/chosen"),
    updateState: record(
      "updateState",
      async () => options.update ?? { current: "0.1.0", kind: "idle" as const },
    ),
    checkForUpdate: record(
      "checkForUpdate",
      async () => options.update ?? { current: "0.1.0", kind: "up-to-date" as const, checkedAt: 0 },
    ),
    installUpdate: record("installUpdate", async () => {}),
  };
  return {
    bridge,
    calls,
    emit: (event: AppEvent) => listener?.(event),
    named: (n: string) => calls.filter((c) => c[0] === n),
  };
};
