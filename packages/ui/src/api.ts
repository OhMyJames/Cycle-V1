// The contract between the Electron main process and the renderer. Types only: nothing here runs.
//
// The main process holds the connections and, for every session being watched, its conversation. The
// renderer asks, and is told of changes. A renderer that reloads asks again and is given the state
// whole: it does not depend on having been there for what came before.
import type { SessionUpdate } from "@cycle/acp";
import type { Conversation } from "./model/index.ts";

export type HostConfig =
  | { id: string; name: string; kind: "local" }
  | {
      id: string;
      name: string;
      kind: "ssh";
      /** What `ssh` takes: `host`, `user@host`, or an alias from ~/.ssh/config. */
      host: string;
      /** What to run on the far side. Default: `cycle proxy`. */
      command?: string[];
    };

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export type HostStatus = {
  hostId: string;
  state: ConnectionState;
  error?: string;
  /**
   * What the daemon on the host can do beyond what every daemon does (docs/protocol.md §3). Absent until it has said: a
   * client that needs one of them waits, and does not assume.
   */
  capabilities?: { queue: boolean; files: boolean };
  /** What the daemon on the host says it is. Not for the local one, which the app carries. */
  daemon?: {
    version: string;
    /** Set when it is older than this app: what to run on that machine to update it. */
    upgrade?: string;
  };
};

export type SessionSummary = {
  hostId: string;
  sessionId: string;
  cwd: string;
  title?: string;
  archived: boolean;
  agent: string;
  state: "running" | "idle" | "requires_action" | "stopped";
  lastSeq: number;
  /**
   * When something last happened in the session (ISO 8601). Absent from a daemon older than protocol 0.2:
   * then the sessions of that daemon are ordered by `lastSeq`, which only compares within one daemon.
   */
  updatedAt?: string;
  /** What the session was set to, by name (the agent's settings). */
  config?: Record<string, string>;
};

export type AgentInfo = {
  id: string;
  name: string;
  available: boolean;
  /** JSON Schema of the agent's settings. The UI draws a form from it. */
  configSchema: Record<string, unknown>;
  /** What the agent takes in a prompt beyond text (ACP `PromptCapabilities`). Absent from a daemon that does not say. */
  promptCapabilities?: { image?: object | null | undefined } | undefined;
};

/** What a message to an agent is made of: text, and images as ACP carries them (base64). */
export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  /** A reference to a file or folder on the daemon's machine: `uri` is `file://`, a folder's ending in `/`. */
  | { type: "resource_link"; name: string; uri: string; _meta?: Record<string, unknown> };

export type FileHit = { path: string; kind: "file" | "folder" };

/** `root` is the session's folder as the daemon knows it; `path` is relative to it. */
export type FileSearch = { root: string; entries: FileHit[]; truncated: boolean };

export type PermissionOption = { optionId: string; name: string; kind: string };

/** An agent asking the user. `key` names it in this app; answer it with `answerPermission`. */
export type PermissionRequest = {
  key: string;
  hostId: string;
  sessionId: string;
  title: string;
  /** What the agent wants to do, as ACP gives it. Shown, never trusted. */
  subject?: unknown;
  options: PermissionOption[];
};

/** A session as the renderer is given it: everything needed to draw it, at one moment. */
export type SessionSnapshot = {
  conversation: Conversation;
  permissions: PermissionRequest[];
  /** How many events about this session main has sent: the next one is this plus one. */
  version: number;
};

/** Where the app's own updating stands. `current` is the version that is running. */
export type UpdateState = {
  current: string;
} /** Not an installed app (a development run), or not a build that can replace itself. */ & (
  | { kind: "disabled"; reason: string }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; checkedAt: number }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; received: number; total: number }
  /** Unpacked and checked; the app is about to close and open again as the new version. */
  | { kind: "installing"; version: string }
  /** `version` is set when it was installing that version that failed: the user can try again. */
  | { kind: "error"; message: string; version?: string }
);

/** What main tells the renderer. */
export type AppEvent =
  | { type: "hosts"; hosts: HostConfig[] }
  | ({ type: "host-status" } & HostStatus)
  | { type: "sessions"; hostId: string; sessions: SessionSummary[] }
  | {
      type: "update";
      hostId: string;
      sessionId: string;
      update: SessionUpdate;
      /** The session's version after this update. */
      version: number;
    }
  | { type: "permission"; request: PermissionRequest; version: number }
  | { type: "permission-closed"; hostId: string; sessionId: string; key: string; version: number }
  | { type: "agent-defaults"; hostId: string; agent: string }
  /** A session was deleted elsewhere while the connection was away: nothing of it is kept. */
  | { type: "session-gone"; hostId: string; sessionId: string }
  | { type: "app-update"; state: UpdateState }
  /** A notification was pressed: show this session. */
  | { type: "focus-session"; hostId: string; sessionId: string };

export type NewSession = { cwd: string; agent?: string; config?: Record<string, string> };

/** What the renderer asks of main. Every method can fail; the renderer shows the message. */
export type AppApi = {
  /**
   * Every host, how its connection stands, and the last list of sessions main read from each: a host that is
   * away still has its last list, which is shown greyed. Only for as long as the app runs: one that could not be
   * reached since it started has none.
   */
  hosts(): Promise<{
    hosts: HostConfig[];
    status: HostStatus[];
    sessions: Record<string, SessionSummary[]>;
  }>;
  saveHost(host: HostConfig): Promise<void>;
  removeHost(hostId: string): Promise<void>;
  connect(hostId: string): Promise<void>;
  disconnect(hostId: string): Promise<void>;

  sessions(hostId: string): Promise<SessionSummary[]>;
  createSession(hostId: string, params: NewSession): Promise<string>;
  /** Starts watching a session and returns it whole. Call again after a reload. */
  openSession(hostId: string, sessionId: string): Promise<SessionSnapshot>;
  /** A text, or blocks: text and images. */
  prompt(hostId: string, sessionId: string, content: string | PromptBlock[]): Promise<void>;
  cancel(hostId: string, sessionId: string): Promise<void>;
  /** Files and folders of the session's folder, on the machine of the daemon, that fit what was typed after an @. */
  searchFiles(hostId: string, sessionId: string, query: string): Promise<FileSearch>;
  /** Takes a prompt back out of the queue, to be edited. Answers with its blocks; fails if it has gone. */
  dequeue(hostId: string, sessionId: string, queueId: string): Promise<PromptBlock[]>;
  setSessionConfig(
    hostId: string,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void>;
  renameSession(hostId: string, sessionId: string, title: string): Promise<void>;
  archiveSession(hostId: string, sessionId: string, archived: boolean): Promise<void>;
  deleteSession(hostId: string, sessionId: string): Promise<void>;
  answerPermission(key: string, optionId: string | "cancelled"): Promise<void>;

  agents(hostId: string): Promise<AgentInfo[]>;
  agentDefaults(hostId: string, agent: string): Promise<Record<string, string>>;
  setAgentDefaults(hostId: string, agent: string, config: Record<string, string>): Promise<void>;

  /** A directory chosen by the user, or undefined if they cancelled. */
  chooseDirectory(): Promise<string | undefined>;

  updateState(): Promise<UpdateState>;
  /** Asks now, and answers with what it found (or why it could not). */
  checkForUpdate(): Promise<UpdateState>;
  /** Downloads the update that was found, checks it, and restarts the app as the new version. */
  installUpdate(): Promise<void>;
};

/** Subscribes to events. Returns the function that stops it. */
export type AppEvents = (listener: (event: AppEvent) => void) => () => void;

export type CycleBridge = AppApi & { onEvent: AppEvents };

/** Every method of AppApi, as a value, so the preload and main agree on the channels without a list in each. */
export const API_METHODS = [
  "hosts",
  "saveHost",
  "removeHost",
  "connect",
  "disconnect",
  "sessions",
  "createSession",
  "openSession",
  "prompt",
  "cancel",
  "dequeue",
  "searchFiles",
  "setSessionConfig",
  "renameSession",
  "archiveSession",
  "deleteSession",
  "answerPermission",
  "agents",
  "agentDefaults",
  "setAgentDefaults",
  "chooseDirectory",
  "updateState",
  "checkForUpdate",
  "installUpdate",
] as const satisfies readonly (keyof AppApi)[];

export const channel = (method: string): string => `cycle:${method}`;
export const EVENT_CHANNEL = "cycle:event";
