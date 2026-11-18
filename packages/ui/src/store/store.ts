// The renderer's state, and what it does about events and clicks. Plain TypeScript, no React: React
// only reads it (useSyncExternalStore) and calls its methods, so it is tested with a fake bridge.
import type {
  AgentInfo,
  AppEvent,
  CycleBridge,
  FileSearch,
  HostConfig,
  HostStatus,
  NewSession,
  PermissionRequest,
  PromptBlock,
  SessionSnapshot,
  SessionSummary,
  UpdateState,
} from "../api.ts";
import { DraftStore, promptBlocks, returnedId } from "../draft.ts";
import { applyUpdate, type Conversation, emptyConversation } from "../model/index.ts";

export const viewKey = (hostId: string, sessionId: string): string => `${hostId}:${sessionId}`;

export type SessionView = {
  hostId: string;
  sessionId: string;
  conversation: Conversation;
  permissions: PermissionRequest[];
  /** The version of main's state this view is at. The next event is this plus one. */
  version: number;
  loading: boolean;
};

export type AppState = {
  ready: boolean;
  hosts: HostConfig[];
  status: Record<string, HostStatus>;
  sessions: Record<string, SessionSummary[]>;
  agents: Record<string, AgentInfo[]>;
  /** Counts changes to an agent's defaults, so a form that shows them knows to read them again. */
  defaultsRevision: Record<string, number>;
  selectedHost: string | undefined;
  selectedSession: string | undefined;
  views: Record<string, SessionView>;
  /** The last thing that went wrong, for the user to read and dismiss. */
  error: string | undefined;
  /** The app's own updating. Undefined until main has said. */
  update: UpdateState | undefined;
};

const initial = (): AppState => ({
  ready: false,
  hosts: [],
  status: {},
  sessions: {},
  agents: {},
  defaultsRevision: {},
  selectedHost: undefined,
  selectedSession: undefined,
  views: {},
  error: undefined,
  update: undefined,
});

const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  // Electron wraps what main throws: "Error invoking remote method 'x': Error: the real message".
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
};

export class AppStore {
  readonly #bridge: CycleBridge;
  #state: AppState = initial();
  readonly #listeners = new Set<() => void>();
  /** Events about a session that is still being opened, held until its snapshot is in. */
  readonly #held = new Map<string, AppEvent[]>();
  #stop: (() => void) | undefined;
  /** What each session's box holds, written and not sent. */
  readonly drafts: DraftStore;

  constructor(bridge: CycleBridge, drafts: DraftStore = new DraftStore()) {
    this.#bridge = bridge;
    this.drafts = drafts;
  }

  getState = (): AppState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(change: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void {
    const next = typeof change === "function" ? change(this.#state) : change;
    this.#state = { ...this.#state, ...next };
    for (const listener of [...this.#listeners]) listener();
  }

  /** Runs an action, and shows what went wrong instead of throwing it into the page. */
  async #attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (error) {
      this.#set({ error: messageOf(error) });
      return undefined;
    }
  }

  dismissError = (): void => this.#set({ error: undefined });

  /** Starts listening to main and reads what it has. Call once. */
  async start(): Promise<void> {
    this.#stop = this.#bridge.onEvent((event) => this.#onEvent(event));
    void this.#attempt(async () => {
      const update = await this.#bridge.updateState();
      // An event that came while this was asked is newer than the answer.
      this.#set((s) => (s.update === undefined ? { update } : {}));
    });
    await this.#attempt(async () => {
      const { hosts, status } = await this.#bridge.hosts();
      this.#set({
        ready: true,
        hosts,
        status: Object.fromEntries(status.map((s) => [s.hostId, s])),
      });
      const first = hosts[0];
      if (first !== undefined) await this.selectHost(first.id);
    });
    this.#set({ ready: true });
  }

  stop(): void {
    this.#stop?.();
  }

  // ---- what main tells us ----

  #onEvent(event: AppEvent): void {
    switch (event.type) {
      case "hosts":
        this.#set({ hosts: event.hosts });
        return;
      case "host-status":
        this.#set((s) => ({ status: { ...s.status, [event.hostId]: toStatus(event) } }));
        return;
      case "sessions":
        this.#set((s) => ({ sessions: { ...s.sessions, [event.hostId]: event.sessions } }));
        return;
      case "agent-defaults":
        this.#set((s) => ({
          defaultsRevision: {
            ...s.defaultsRevision,
            [event.hostId]: (s.defaultsRevision[event.hostId] ?? 0) + 1,
          },
        }));
        return;
      case "app-update":
        this.#set({ update: event.state });
        return;
      case "update":
        this.#onSessionEvent(viewKey(event.hostId, event.sessionId), event);
        return;
      case "permission":
        this.#onSessionEvent(viewKey(event.request.hostId, event.request.sessionId), event);
        return;
      case "permission-closed":
        this.#onSessionEvent(viewKey(event.hostId, event.sessionId), event);
        return;
    }
  }

  #onSessionEvent(key: string, event: AppEvent & { version: number }): void {
    const view = this.#state.views[key];
    if (view === undefined) return;
    if (view.loading) {
      this.#held.set(key, [...(this.#held.get(key) ?? []), event]);
      return;
    }
    if (event.version <= view.version) return;
    if (event.version > view.version + 1) {
      // One was missed. Ask main for the session again rather than show something wrong.
      void this.#reopen(view.hostId, view.sessionId);
      return;
    }
    this.#setView(key, applyToView(view, event));
  }

  #setView(key: string, view: SessionView): void {
    this.#takeBack(key, view);
    this.#set((s) => ({ views: { ...s.views, [key]: view } }));
  }

  /**
   * What the daemon handed back (a stop, an error) goes into that session's box, whether or not it is the one in
   * view, once: a reload of the page finds the same hand-back and does not put it there again.
   */
  #takeBack(key: string, view: SessionView): void {
    const returned = view.conversation.returned;
    if (returned === undefined || view.loading) return;
    const id = returnedId(returned.prompts);
    if (this.drafts.handled(key, id)) return;
    this.drafts.markHandled(key, id);
    this.drafts.restore(
      key,
      returned.prompts.map((p) => p.prompt),
    );
  }

  async #reopen(hostId: string, sessionId: string): Promise<void> {
    await this.#attempt(() => this.#load(hostId, sessionId));
  }

  /** Reads a session from main whole, then applies the events that came while it was being read. */
  async #load(hostId: string, sessionId: string): Promise<void> {
    const key = viewKey(hostId, sessionId);
    const existing = this.#state.views[key];
    this.#held.set(key, []);
    this.#setView(key, {
      hostId,
      sessionId,
      conversation: existing?.conversation ?? emptyConversation(),
      permissions: existing?.permissions ?? [],
      version: existing?.version ?? -1,
      loading: true,
    });
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.#bridge.openSession(hostId, sessionId);
    } catch (error) {
      this.#held.delete(key);
      this.#set((s) => {
        const { [key]: _gone, ...views } = s.views;
        return { views };
      });
      throw error;
    }
    let view: SessionView = {
      hostId,
      sessionId,
      conversation: snapshot.conversation,
      permissions: snapshot.permissions,
      version: snapshot.version,
      loading: false,
    };
    for (const event of this.#held.get(key) ?? []) {
      const version = (event as { version: number }).version;
      if (version === view.version + 1)
        view = applyToView(view, event as AppEvent & { version: number });
    }
    this.#held.delete(key);
    this.#setView(key, view);
  }

  // ---- what the user does ----

  /** Selects a host, connecting to it if it is not. */
  selectHost = async (hostId: string): Promise<void> => {
    this.#set({ selectedHost: hostId, selectedSession: undefined });
    await this.#attempt(async () => {
      const state = this.#state.status[hostId]?.state;
      if (state !== "connected" && state !== "connecting" && state !== "reconnecting") {
        await this.#bridge.connect(hostId);
      }
      const [sessions, agents] = await Promise.all([
        this.#bridge.sessions(hostId),
        this.#bridge.agents(hostId),
      ]);
      this.#set((s) => ({
        sessions: { ...s.sessions, [hostId]: sessions },
        agents: { ...s.agents, [hostId]: agents },
      }));
    });
  };

  /** Reads the sessions of every connected host that has not been read, so that a search can span hosts. */
  loadAllSessions = async (): Promise<void> => {
    const hostIds = Object.values(this.#state.status)
      .filter((s) => s.state === "connected" && this.#state.sessions[s.hostId] === undefined)
      .map((s) => s.hostId);
    await Promise.all(
      hostIds.map((hostId) =>
        this.#attempt(async () => {
          const sessions = await this.#bridge.sessions(hostId);
          this.#set((s) => ({ sessions: { ...s.sessions, [hostId]: sessions } }));
        }),
      ),
    );
  };

  selectSession = async (sessionId: string): Promise<void> => {
    const hostId = this.#state.selectedHost;
    if (hostId === undefined) return;
    this.#set({ selectedSession: sessionId });
    await this.#attempt(() => this.#load(hostId, sessionId));
  };

  createSession = async (params: NewSession): Promise<void> => {
    const hostId = this.#state.selectedHost;
    if (hostId === undefined) return;
    const sessionId = await this.#attempt(() => this.#bridge.createSession(hostId, params));
    if (sessionId !== undefined) await this.selectSession(sessionId);
  };

  /**
   * Sends what the selected session's box holds: its text, and the images attached to it. The box is empty from the
   * moment it goes; if it cannot go, what was in it comes back, in front of anything written since.
   */
  send = async (): Promise<void> => {
    const { selectedHost: hostId, selectedSession: sessionId } = this.#state;
    if (hostId === undefined || sessionId === undefined) return;
    const key = viewKey(hostId, sessionId);
    const content: PromptBlock[] | undefined = promptBlocks(this.drafts.get(key));
    if (content === undefined) return;
    this.drafts.clear(key);
    const sent = await this.#attempt(async () => {
      await this.#bridge.prompt(hostId, sessionId, content);
      return true;
    });
    if (sent !== true) this.drafts.restore(key, [content]);
  };

  /** What fits an @ in the selected session's box. Quiet when it cannot say: a menu that is not there is enough. */
  searchFiles = async (query: string): Promise<FileSearch | undefined> => {
    const { selectedHost: hostId, selectedSession: sessionId } = this.#state;
    if (hostId === undefined || sessionId === undefined) return undefined;
    try {
      return await this.#bridge.searchFiles(hostId, sessionId, query);
    } catch {
      return undefined;
    }
  };

  /** Takes a queued prompt back to edit it. Undefined if it had gone to the agent, or came back, meanwhile. */
  dequeue = async (queueId: string): Promise<PromptBlock[] | undefined> => {
    const { selectedHost: hostId, selectedSession: sessionId } = this.#state;
    if (hostId === undefined || sessionId === undefined) return undefined;
    const blocks = await this.#attempt(() => this.#bridge.dequeue(hostId, sessionId, queueId));
    if (blocks !== undefined) this.drafts.restore(viewKey(hostId, sessionId), [blocks]);
    return blocks;
  };

  cancel = async (): Promise<void> => {
    const { selectedHost: hostId, selectedSession: sessionId } = this.#state;
    if (hostId === undefined || sessionId === undefined) return;
    await this.#attempt(() => this.#bridge.cancel(hostId, sessionId));
  };

  setSessionConfig = async (configId: string, value: string): Promise<void> => {
    const { selectedHost: hostId, selectedSession: sessionId } = this.#state;
    if (hostId === undefined || sessionId === undefined) return;
    await this.#attempt(() => this.#bridge.setSessionConfig(hostId, sessionId, configId, value));
  };

  renameSession = async (sessionId: string, title: string): Promise<void> => {
    const hostId = this.#state.selectedHost;
    if (hostId === undefined) return;
    await this.#attempt(() => this.#bridge.renameSession(hostId, sessionId, title));
  };

  archiveSession = async (sessionId: string, archived: boolean): Promise<void> => {
    const hostId = this.#state.selectedHost;
    if (hostId === undefined) return;
    await this.#attempt(() => this.#bridge.archiveSession(hostId, sessionId, archived));
  };

  deleteSession = async (sessionId: string): Promise<void> => {
    const hostId = this.#state.selectedHost;
    if (hostId === undefined) return;
    await this.#attempt(async () => {
      await this.#bridge.deleteSession(hostId, sessionId);
      this.drafts.forget(viewKey(hostId, sessionId));
      this.#set((s) => {
        const { [viewKey(hostId, sessionId)]: _gone, ...views } = s.views;
        return {
          views,
          selectedSession: s.selectedSession === sessionId ? undefined : s.selectedSession,
        };
      });
    });
  };

  answerPermission = async (key: string, optionId: string | "cancelled"): Promise<void> => {
    await this.#attempt(() => this.#bridge.answerPermission(key, optionId));
  };

  saveHost = async (host: HostConfig): Promise<void> => {
    await this.#attempt(() => this.#bridge.saveHost(host));
  };

  removeHost = async (hostId: string): Promise<void> => {
    await this.#attempt(async () => {
      await this.#bridge.removeHost(hostId);
      if (this.#state.selectedHost === hostId) {
        this.#set({ selectedHost: undefined, selectedSession: undefined });
        const next = this.#state.hosts[0];
        if (next !== undefined) await this.selectHost(next.id);
      }
    });
  };

  readAgentDefaults = (
    hostId: string,
    agent: string,
  ): Promise<Record<string, string> | undefined> =>
    this.#attempt(() => this.#bridge.agentDefaults(hostId, agent));

  setAgentDefaults = async (hostId: string, agent: string, config: Record<string, string>) => {
    await this.#attempt(() => this.#bridge.setAgentDefaults(hostId, agent, config));
  };

  chooseDirectory = (): Promise<string | undefined> => this.#bridge.chooseDirectory();

  checkForUpdate = async (): Promise<void> => {
    await this.#attempt(async () => this.#set({ update: await this.#bridge.checkForUpdate() }));
  };

  /** Main says how it goes through app-update events; an error it throws is shown as any other. */
  installUpdate = async (): Promise<void> => {
    await this.#attempt(() => this.#bridge.installUpdate());
  };
}

const toStatus = (event: AppEvent & { type: "host-status" }): HostStatus => ({
  hostId: event.hostId,
  state: event.state,
  ...(event.error !== undefined ? { error: event.error } : {}),
  ...(event.daemon !== undefined ? { daemon: event.daemon } : {}),
  ...(event.capabilities !== undefined ? { capabilities: event.capabilities } : {}),
});

const applyToView = (view: SessionView, event: AppEvent & { version: number }): SessionView => {
  if (event.type === "update") {
    return {
      ...view,
      conversation: applyUpdate(view.conversation, event.update),
      version: event.version,
    };
  }
  if (event.type === "permission") {
    const others = view.permissions.filter((p) => p.key !== event.request.key);
    return { ...view, permissions: [...others, event.request], version: event.version };
  }
  if (event.type === "permission-closed") {
    return {
      ...view,
      permissions: view.permissions.filter((p) => p.key !== event.key),
      version: event.version,
    };
  }
  return view;
};
