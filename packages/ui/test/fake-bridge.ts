import type { SessionUpdate } from "@cycle/acp";
import type {
  AppEvent,
  ConnectionState,
  CycleBridge,
  HostConfig,
  SessionSnapshot,
  SessionSummary,
  UpdateState,
} from "../src/api.ts";
import { emptyConversation } from "../src/model/index.ts";

export const LOCAL: HostConfig = { id: "local", name: "This computer", kind: "local" };
export const summary = (sessionId: string, hostId = "local"): SessionSummary => ({
  hostId,
  sessionId,
  cwd: "/work",
  archived: false,
  agent: "fake",
  state: "idle",
  lastSeq: 0,
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
    /** More hosts than the local one, and how each stands (by id; the local one's is `connected`). */
    hosts?: HostConfig[];
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
    hosts: record("hosts", async () => {
      const hosts = [LOCAL, ...(options.hosts ?? [])];
      return {
        hosts,
        status: hosts.map((h) => ({
          hostId: h.id,
          state: options.states?.[h.id] ?? (options.connected === false ? "closed" : "connected"),
        })),
        // What main has read of each host, through the same call a test may replace to say what a list holds.
        sessions: Object.fromEntries(
          await Promise.all(hosts.map(async (h) => [h.id, await bridge.sessions(h.id)] as const)),
        ),
      };
    }),
    saveHost: record("saveHost", async () => {}),
    removeHost: record("removeHost", async () => {}),
    connect: record("connect", async () => {}),
    disconnect: record("disconnect", async () => {}),
    sessions: record("sessions", async (hostId: string) => [summary("s1", hostId)]),
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
    setSessionConfig: record("setSessionConfig", async () => {}),
    renameSession: record("renameSession", async () => {}),
    archiveSession: record("archiveSession", async () => {}),
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
