// The renderer's state, and what it does about events and clicks. Plain TypeScript, no React: React
// only reads it (useSyncExternalStore) and calls its methods, so it is tested with a fake bridge.
import type {
  AgentInfo,
  AppEvent,
  CycleBridge,
  EnvironmentConfig,
  EnvironmentStatus,
  FileSearch,
  FolderListing,
  NewSession,
  PermissionRequest,
  PromptBlock,
  SessionSnapshot,
  SessionSummary,
  UpdateState,
} from "../api.ts";
import { DraftStore, promptBlocks, returnedId } from "../draft.ts";
import { applyUpdate, type Conversation, emptyConversation } from "../model/index.ts";

export const viewKey = (environmentId: string, sessionId: string): string =>
  `${environmentId}:${sessionId}`;

export type SessionView = {
  environmentId: string;
  sessionId: string;
  conversation: Conversation;
  permissions: PermissionRequest[];
  /** The version of main's state this view is at. The next event is this plus one. */
  version: number;
  loading: boolean;
};

export type AppState = {
  ready: boolean;
  environments: EnvironmentConfig[];
  status: Record<string, EnvironmentStatus>;
  sessions: Record<string, SessionSummary[]>;
  agents: Record<string, AgentInfo[]>;
  /** Counts changes to an agent's defaults, so a form that shows them knows to read them again. */
  defaultsRevision: Record<string, number>;
  selectedEnvironment: string | undefined;
  selectedSession: string | undefined;
  views: Record<string, SessionView>;
  /** The last thing that went wrong, for the user to read and dismiss. */
  error: string | undefined;
  /** The app's own updating. Undefined until main has said. */
  update: UpdateState | undefined;
};

const initial = (): AppState => ({
  ready: false,
  environments: [],
  status: {},
  sessions: {},
  agents: {},
  defaultsRevision: {},
  selectedEnvironment: undefined,
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
      const { environments, status, sessions } = await this.#bridge.environments();
      this.#set({
        ready: true,
        environments,
        status: Object.fromEntries(status.map((s) => [s.environmentId, s])),
        // What main has read so far, also from an environment that has since gone away.
        sessions,
        selectedEnvironment: environments[0]?.id,
      });
      // Main connects every environment: the agents of those that already are, now; of the others, when each connects.
      await Promise.all(
        status.filter((s) => s.state === "connected").map((s) => this.#loadAgents(s.environmentId)),
      );
    });
    this.#set({ ready: true });
  }

  stop(): void {
    this.#stop?.();
  }

  // ---- what main tells us ----

  #onEvent(event: AppEvent): void {
    switch (event.type) {
      case "environments":
        this.#set({ environments: event.environments });
        return;
      case "environment-status": {
        const was = this.#state.status[event.environmentId]?.state;
        this.#set((s) => ({ status: { ...s.status, [event.environmentId]: toStatus(event) } }));
        if (event.state === "connected" && was !== "connected")
          void this.#loadAgents(event.environmentId);
        return;
      }
      case "sessions":
        this.#set((s) => ({ sessions: { ...s.sessions, [event.environmentId]: event.sessions } }));
        return;
      case "agent-defaults":
        this.#set((s) => ({
          defaultsRevision: {
            ...s.defaultsRevision,
            [event.environmentId]: (s.defaultsRevision[event.environmentId] ?? 0) + 1,
          },
        }));
        return;
      case "app-update":
        this.#set({ update: event.state });
        return;
      case "focus-session":
        void this.focusSession(event.environmentId, event.sessionId);
        return;
      case "session-gone":
        this.#forgetSession(event.environmentId, event.sessionId);
        return;
      case "update":
        this.#onSessionEvent(viewKey(event.environmentId, event.sessionId), event);
        return;
      case "permission":
        this.#onSessionEvent(viewKey(event.request.environmentId, event.request.sessionId), event);
        return;
      case "permission-closed":
        this.#onSessionEvent(viewKey(event.environmentId, event.sessionId), event);
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
      void this.#reopen(view.environmentId, view.sessionId);
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

  async #reopen(environmentId: string, sessionId: string): Promise<void> {
    await this.#attempt(() => this.#load(environmentId, sessionId));
  }

  /** Reads a session from main whole, then applies the events that came while it was being read. */
  async #load(environmentId: string, sessionId: string): Promise<void> {
    const key = viewKey(environmentId, sessionId);
    const existing = this.#state.views[key];
    this.#held.set(key, []);
    this.#setView(key, {
      environmentId,
      sessionId,
      conversation: existing?.conversation ?? emptyConversation(),
      permissions: existing?.permissions ?? [],
      version: existing?.version ?? -1,
      loading: true,
    });
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.#bridge.openSession(environmentId, sessionId);
    } catch (error) {
      this.#held.delete(key);
      // What was read before is still what there is: a re-read that failed does not take the conversation away.
      if (existing !== undefined) this.#setView(key, { ...existing, loading: false });
      else
        this.#set((s) => {
          const { [key]: _gone, ...views } = s.views;
          return { views };
        });
      throw error;
    }
    let view: SessionView = {
      environmentId,
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

  /** Asks main to connect to an environment again. Why it cannot is in the environment's status, not in an error to dismiss. */
  connectEnvironment = async (environmentId: string): Promise<void> => {
    try {
      await this.#bridge.connect(environmentId);
    } catch {
      // The status says why.
    }
  };

  async #loadAgents(environmentId: string): Promise<void> {
    await this.#attempt(async () => {
      const agents = await this.#bridge.agents(environmentId);
      this.#set((s) => ({ agents: { ...s.agents, [environmentId]: agents } }));
    });
  }

  /** Shows a session of any environment: a notification about it was pressed. */
  focusSession = async (environmentId: string, sessionId: string): Promise<void> => {
    if (!this.#state.sessions[environmentId]?.some((s) => s.sessionId === sessionId)) return;
    await this.selectSession(environmentId, sessionId);
  };

  /**
   * Opens a session, on the environment it is on. An environment that is away still lists its sessions, as they were: one that was
   * open before can be read again, as it was; one that was not has nothing to show, and the person is told why.
   */
  selectSession = async (environmentId: string, sessionId: string): Promise<void> => {
    const state = this.#state.status[environmentId]?.state;
    if (
      state !== "connected" &&
      this.#state.views[viewKey(environmentId, sessionId)] === undefined
    ) {
      const name =
        this.#state.environments.find((h) => h.id === environmentId)?.name ?? environmentId;
      this.#set({ error: `${name} is not connected, so this session cannot be opened.` });
      return;
    }
    this.#set({ selectedEnvironment: environmentId, selectedSession: sessionId });
    if (state === "connected") await this.#attempt(() => this.#load(environmentId, sessionId));
  };

  createSession = async (environmentId: string, params: NewSession): Promise<void> => {
    const sessionId = await this.#attempt(() => this.#bridge.createSession(environmentId, params));
    if (sessionId !== undefined) await this.selectSession(environmentId, sessionId);
  };

  /**
   * Sends what the selected session's box holds: its text, and the images attached to it. The box is empty from the
   * moment it goes; if it cannot go, what was in it comes back, in front of anything written since.
   */
  send = async (): Promise<void> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined) return;
    const key = viewKey(environmentId, sessionId);
    const content: PromptBlock[] | undefined = promptBlocks(this.drafts.get(key));
    if (content === undefined) return;
    this.drafts.clear(key);
    const sent = await this.#attempt(async () => {
      await this.#bridge.prompt(environmentId, sessionId, content);
      return true;
    });
    if (sent !== true) this.drafts.restore(key, [content]);
  };

  /** What fits an @ in the selected session's box. Quiet when it cannot say: a menu that is not there is enough. */
  searchFiles = async (query: string): Promise<FileSearch | undefined> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined) return undefined;
    try {
      return await this.#bridge.searchFiles(environmentId, sessionId, query);
    } catch {
      return undefined;
    }
  };

  /** The folders in a folder on an environment's machine. Not a banner when it fails: the one who asked says why. */
  listFolders = (environmentId: string, path?: string, hidden?: boolean): Promise<FolderListing> =>
    this.#bridge.listFolders(environmentId, path, hidden);

  /** Takes a queued prompt back to edit it. Undefined if it had gone to the agent, or came back, meanwhile. */
  dequeue = async (queueId: string): Promise<PromptBlock[] | undefined> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined) return undefined;
    const blocks = await this.#attempt(() =>
      this.#bridge.dequeue(environmentId, sessionId, queueId),
    );
    if (blocks !== undefined) this.drafts.restore(viewKey(environmentId, sessionId), [blocks]);
    return blocks;
  };

  cancel = async (): Promise<void> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined) return;
    await this.#attempt(() => this.#bridge.cancel(environmentId, sessionId));
  };

  setSessionConfig = async (configId: string, value: string): Promise<void> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined) return;
    await this.#attempt(() =>
      this.#bridge.setSessionConfig(environmentId, sessionId, configId, value),
    );
  };

  renameSession = async (sessionId: string, title: string): Promise<void> => {
    const environmentId = this.#state.selectedEnvironment;
    if (environmentId === undefined) return;
    await this.#attempt(() => this.#bridge.renameSession(environmentId, sessionId, title));
  };

  archiveSession = async (sessionId: string, archived: boolean): Promise<void> => {
    const environmentId = this.#state.selectedEnvironment;
    if (environmentId === undefined) return;
    await this.#attempt(() => this.#bridge.archiveSession(environmentId, sessionId, archived));
  };

  /**
   * The person is looking at the session: tell the daemon it has been seen. Nothing to show if it cannot be told (the
   * mark stays, and is tried again with the next list): a mark is not worth an error banner.
   */
  markRead = async (environmentId: string, sessionId: string): Promise<void> => {
    try {
      await this.#bridge.markRead(environmentId, sessionId);
    } catch {
      // Not worth a banner.
    }
  };

  deleteSession = async (sessionId: string): Promise<void> => {
    const environmentId = this.#state.selectedEnvironment;
    if (environmentId === undefined) return;
    await this.#attempt(async () => {
      await this.#bridge.deleteSession(environmentId, sessionId);
      this.#forgetSession(environmentId, sessionId);
    });
  };

  /** A session that no longer exists: its view, its draft and its place as the selected one go. */
  #forgetSession(environmentId: string, sessionId: string): void {
    const key = viewKey(environmentId, sessionId);
    this.drafts.forget(key);
    this.#held.delete(key);
    this.#set((s) => {
      const { [key]: _gone, ...views } = s.views;
      return {
        views,
        selectedSession:
          s.selectedEnvironment === environmentId && s.selectedSession === sessionId
            ? undefined
            : s.selectedSession,
      };
    });
  }

  answerPermission = async (key: string, optionId: string | "cancelled"): Promise<void> => {
    await this.#attempt(() => this.#bridge.answerPermission(key, optionId));
  };

  saveEnvironment = async (environment: EnvironmentConfig): Promise<void> => {
    const saved = await this.#attempt(async () => {
      await this.#bridge.saveEnvironment(environment);
      return true;
    });
    // An environment that is added is connected at once, as every environment is when the app starts.
    if (saved === true) await this.connectEnvironment(environment.id);
  };

  removeEnvironment = async (environmentId: string): Promise<void> => {
    await this.#attempt(async () => {
      await this.#bridge.removeEnvironment(environmentId);
      this.drafts.forgetEnvironment(environmentId);
      this.#set((s) => {
        const { [environmentId]: _sessions, ...sessions } = s.sessions;
        const { [environmentId]: _agents, ...agents } = s.agents;
        const { [environmentId]: _status, ...status } = s.status;
        const views = Object.fromEntries(
          Object.entries(s.views).filter(([, view]) => view.environmentId !== environmentId),
        );
        const open = s.selectedEnvironment === environmentId;
        return {
          sessions,
          agents,
          status,
          views,
          ...(open
            ? {
                selectedEnvironment: s.environments.find((h) => h.id !== environmentId)?.id,
                selectedSession: undefined,
              }
            : {}),
        };
      });
    });
  };

  readAgentDefaults = (
    environmentId: string,
    agent: string,
  ): Promise<Record<string, string> | undefined> =>
    this.#attempt(() => this.#bridge.agentDefaults(environmentId, agent));

  setAgentDefaults = async (
    environmentId: string,
    agent: string,
    config: Record<string, string>,
  ) => {
    await this.#attempt(() => this.#bridge.setAgentDefaults(environmentId, agent, config));
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

const toStatus = (event: AppEvent & { type: "environment-status" }): EnvironmentStatus => ({
  environmentId: event.environmentId,
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
