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
      /** What to run on the far side. Default: `cycle-daemon proxy`. */
      command?: string[];
    };

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export type HostStatus = { hostId: string; state: ConnectionState; error?: string };

export type SessionSummary = {
  hostId: string;
  sessionId: string;
  cwd: string;
  title?: string;
  archived: boolean;
  agent: string;
  state: "running" | "idle" | "requires_action" | "stopped";
  lastSeq: number;
  /** What the session was set to, by name (the agent's settings). */
  config?: Record<string, string>;
};

export type AgentInfo = {
  id: string;
  name: string;
  available: boolean;
  /** JSON Schema of the agent's settings. The UI draws a form from it. */
  configSchema: Record<string, unknown>;
};

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
  | { type: "agent-defaults"; hostId: string; agent: string };

export type NewSession = { cwd: string; agent?: string; config?: Record<string, string> };

/** What the renderer asks of main. Every method can fail; the renderer shows the message. */
export type AppApi = {
  hosts(): Promise<{ hosts: HostConfig[]; status: HostStatus[] }>;
  saveHost(host: HostConfig): Promise<void>;
  removeHost(hostId: string): Promise<void>;
  connect(hostId: string): Promise<void>;
  disconnect(hostId: string): Promise<void>;

  sessions(hostId: string): Promise<SessionSummary[]>;
  createSession(hostId: string, params: NewSession): Promise<string>;
  /** Starts watching a session and returns it whole. Call again after a reload. */
  openSession(hostId: string, sessionId: string): Promise<SessionSnapshot>;
  prompt(hostId: string, sessionId: string, text: string): Promise<void>;
  cancel(hostId: string, sessionId: string): Promise<void>;
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
};

/** Subscribes to events. Returns the function that stops it. */
export type AppEvents = (listener: (event: AppEvent) => void) => () => void;

export type CycleBridge = AppApi & { onEvent: AppEvents };
