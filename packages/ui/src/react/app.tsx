import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import {
  createResizableController,
  Resizable,
  ResizableHandle,
  ResizablePanel,
} from "@ui-sdk/react/resizable";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usageLabel } from "../model/index.ts";
import {
  currentWorkspace,
  elsewhere as elsewhereOf,
  sessionKey,
  sessionList,
  workspacesOf,
} from "../sessions.ts";
import { viewKey } from "../store/index.ts";
import { thinking } from "../thinking.ts";
import { CodeThemePicker } from "./code-theme-picker.tsx";
import { Composer } from "./composer.tsx";
import { ConfigForm } from "./config-form.tsx";
import { ConversationView } from "./conversation.tsx";
import {
  AgentDefaultsDialog,
  ConfirmDialog,
  EnvironmentDialog,
  NewSessionDialog,
  RenameDialog,
} from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { ErrorCircleIcon, MoreIcon, SettingsIcon, WarningIcon } from "./icons.tsx";
import { useDay, useInFront } from "./in-front.ts";
import { PermissionCard } from "./permission.tsx";
import { SearchDialog } from "./search.tsx";
import type { Away } from "./session-list.tsx";
import { MOD, Sidebar, sessionTitle } from "./sidebar.tsx";
import { ENVIRONMENT_STATE } from "./status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { DaemonBanner, UpdateBanner, UpdateFooter } from "./update.tsx";

type Panel =
  | "none"
  | "new-session"
  | "add-environment"
  | "defaults"
  | "rename"
  | "delete"
  | "settings"
  | "search";

function SessionSettings({ onClose }: { onClose: () => void }) {
  const store = useAppStore();
  const environment = useAppState((s) => s.selectedEnvironment);
  const sessionId = useAppState((s) => s.selectedSession);
  const sessions = useAppState((s) =>
    environment !== undefined ? s.sessions[environment] : undefined,
  );
  const agents = useAppState((s) =>
    environment !== undefined ? s.agents[environment] : undefined,
  );
  const session = sessions?.find((x) => x.sessionId === sessionId);
  const agent = agents?.find((a) => a.id === session?.agent);
  if (session === undefined || agent === undefined) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogBackdrop />
      <DialogContent>
        <DialogTitle>Session settings</DialogTitle>
        <DialogDescription>A change applies to the next thing the agent does.</DialogDescription>
        <ConfigForm
          schema={agent.configSchema}
          value={session.config ?? {}}
          onChange={(next) => {
            // One setting at a time: the form hands back the whole set, and only what changed is sent.
            const before = session.config ?? {};
            for (const [key, value] of Object.entries(next)) {
              if (before[key] !== value) void store.setSessionConfig(key, value);
            }
          }}
        />
        <div data-slot="row">
          <DialogClose>Close</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function App() {
  const store = useAppStore();
  const { t } = useI18n();
  const showThinking = useSyncExternalStore(thinking.subscribe, thinking.get, thinking.get);
  const ready = useAppState((s) => s.ready);
  const environments = useAppState((s) => s.environments);
  const status = useAppState((s) => s.status);
  const selectedEnvironment = useAppState((s) => s.selectedEnvironment);
  const selectedSession = useAppState((s) => s.selectedSession);
  const sessionsByEnvironment = useAppState((s) => s.sessions);
  const agentsByEnvironment = useAppState((s) => s.agents);
  const views = useAppState((s) => s.views);
  const error = useAppState((s) => s.error);
  const [panel, setPanel] = useState<Panel>("none");
  const [showArchived, setShowArchived] = useState(false);
  const [sent, setSent] = useState(0);
  const [showAll, setShowAll] = useState(false);
  // The workspace chosen in the switcher holds until something else is opened: it is only good for the open session it was chosen on.
  const [chosen, setChosen] = useState<{ workspace: string; on: string | undefined } | undefined>(
    undefined,
  );

  // The sessions of every environment, in one list; what is open is on the environment `selectedEnvironment` names.
  const sessions = useMemo(
    () => environments.flatMap((h) => sessionsByEnvironment[h.id] ?? []),
    [environments, sessionsByEnvironment],
  );
  const agents =
    selectedEnvironment !== undefined ? (agentsByEnvironment[selectedEnvironment] ?? []) : [];
  const session = sessions.find(
    (s) => s.environmentId === selectedEnvironment && s.sessionId === selectedSession,
  );
  const [defaultsEnvironment, setDefaultsEnvironment] = useState<string | undefined>(undefined);
  const connectedEnvironments = environments.filter((h) => status[h.id]?.state === "connected");
  // An environment that is not connected: its sessions are the last it gave, and are shown greyed.
  const away = useMemo(() => {
    const map = new Map<string, Away>();
    for (const h of environments) {
      const state = status[h.id]?.state ?? "closed";
      if (state !== "connected")
        map.set(h.id, { name: h.name, word: ENVIRONMENT_STATE[state].word });
    }
    return map;
  }, [environments, status]);
  const view =
    selectedEnvironment !== undefined && selectedSession !== undefined
      ? views[viewKey(selectedEnvironment, selectedSession)]
      : undefined;
  const environmentState =
    selectedEnvironment !== undefined ? status[selectedEnvironment]?.state : undefined;
  const connected = environmentState === "connected";
  const environmentError =
    selectedEnvironment !== undefined ? status[selectedEnvironment]?.error : undefined;
  const readDefaults = useCallback(
    (environmentId: string, agent: string) => store.readAgentDefaults(environmentId, agent),
    [store],
  );
  const close = () => setPanel("none");
  const [layout] = useState(createResizableController);
  // The workspaces, and the one the sidebar shows; the list on screen and the keys that walk it (Cmd+[ and Cmd+]) are one thing.
  const environmentLabels = useMemo(
    () => environments.map((h) => ({ id: h.id, name: h.name, local: h.kind === "local" })),
    [environments],
  );
  const awayEnvironments = useMemo(() => new Set(away.keys()), [away]);
  const workspaces = useMemo(
    () =>
      workspacesOf(sessions, {
        environments: environmentLabels,
        away: awayEnvironments,
        showArchived,
      }),
    [sessions, environmentLabels, awayEnvironments, showArchived],
  );
  const openKey = session !== undefined ? sessionKey(session) : undefined;
  const current = currentWorkspace(workspaces, {
    chosen: chosen !== undefined && chosen.on === openKey ? chosen.workspace : undefined,
    open: session,
  });
  // A new session starts in the workspace that is shown, if its environment can have one started.
  const startOn =
    current !== undefined && connectedEnvironments.some((h) => h.id === current.environmentId)
      ? current
      : undefined;
  const elsewhere = useMemo(() => elsewhereOf(workspaces, current), [workspaces, current]);
  const day = useDay();
  const list = useMemo(
    () =>
      sessionList(current?.sessions ?? [], {
        showAll,
        selected: openKey,
        away: awayEnvironments,
        now: new Date(day),
      }),
    [current, showAll, openKey, awayEnvironments, day],
  );

  // What is on screen has been seen: the daemon is told, so the mark goes and stays gone (also on another client).
  // Only while the app is in front, and only for a daemon that says there is news.
  const inFront = useInFront();
  // Run again with each list that still says so: a mark that could not be told is tried again with the next list.
  useEffect(() => {
    if (session?.unread !== true || !inFront) return;
    if (status[session.environmentId]?.state !== "connected") return;
    void store.markRead(session.environmentId, session.sessionId);
  }, [session, inFront, status, store]);

  const activity = view?.permissions.length
    ? "requires_action"
    : (view?.conversation.status ?? "idle");
  const firstAllow = view?.permissions[0]?.options.find((o) => o.kind === "allow_once");

  // Keyboard (DESIGN.md section 10). One handler, so every shortcut is in one place.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // ⌘ on a Mac (Ctrl+B and Ctrl+N are cursor keys in a text field there); Ctrl elsewhere.
      const isMac = MOD === "⌘";
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || panel !== "none") return;
      const key = event.key;
      // Typing: a shortcut that decides something (allowing a command) must not fire from a habit of the hand.
      const typing =
        event.target instanceof Element
          ? event.target.closest("textarea, input, [contenteditable]")
          : null;
      const run = (action: () => void) => {
        event.preventDefault();
        action();
      };
      if (key === "k") run(() => setPanel("search"));
      else if (key === "n" && connectedEnvironments.length > 0) run(() => setPanel("new-session"));
      else if (key === "b")
        run(() =>
          layout.isCollapsed("sidebar") ? layout.expand("sidebar") : layout.collapse("sidebar"),
        );
      else if (key === "l")
        run(() =>
          document
            .querySelector<HTMLElement>('[data-slot="composer"] [data-slot="composer-input"]')
            ?.focus(),
        );
      else if (key === "." && connected && activity !== "idle") run(() => void store.cancel());
      else if (
        key === "Enter" &&
        connected &&
        typing === null &&
        firstAllow !== undefined &&
        view?.permissions[0] !== undefined
      ) {
        const request = view.permissions[0];
        run(() => void store.answerPermission(request.key, firstAllow.optionId));
      } else if (key === "[" || key === "]") {
        const at = session === undefined ? -1 : list.order.indexOf(session);
        // A row on an environment that is away and was never opened cannot be opened: the walk goes past it.
        const step = key === "]" ? 1 : -1;
        // The open session is not in the workspace that is shown: the walk starts at the end it is going from.
        let to = at === -1 ? (step === 1 ? 0 : list.order.length - 1) : at + step;
        while (list.order[to] !== undefined && away.has(list.order[to]?.environmentId ?? ""))
          to += step;
        const next = list.order[to];
        if (next !== undefined)
          run(() => void store.selectSession(next.environmentId, next.sessionId));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!ready) return <div data-slot="starting">Starting…</div>;

  return (
    <div data-slot="app">
      <Resizable controller={layout} autoSaveId="cycle-layout">
        <ResizablePanel
          id="sidebar"
          defaultSize="256px"
          minSize="200px"
          maxSize="360px"
          collapsible
          collapsedSize="0px"
        >
          <Sidebar
            environments={environments}
            status={status}
            workspaces={workspaces}
            current={current}
            elsewhere={elsewhere}
            onChooseWorkspace={(workspace) => setChosen({ workspace, on: openKey })}
            list={list}
            selected={openKey}
            away={away}
            showArchived={showArchived}
            onSelectSession={(chosen) =>
              void store.selectSession(chosen.environmentId, chosen.sessionId)
            }
            onNewSession={() => setPanel("new-session")}
            onSearch={() => setPanel("search")}
            onAddEnvironment={() => setPanel("add-environment")}
            onRemoveEnvironment={(id) => void store.removeEnvironment(id)}
            onConnectEnvironment={(id) => void store.connectEnvironment(id)}
            onToggleArchived={() => setShowArchived((v) => !v)}
            onShowAll={() => setShowAll(true)}
            onAgentDefaults={(id) => {
              setDefaultsEnvironment(id);
              setPanel("defaults");
            }}
          >
            <CodeThemePicker />
            <UpdateFooter />
          </Sidebar>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize sidebar" />
        <ResizablePanel id="main" minSize="480px">
          <main data-slot="main">
            <UpdateBanner />
            {selectedEnvironment !== undefined ? (
              <DaemonBanner environmentId={selectedEnvironment} />
            ) : null}
            {error !== undefined ? (
              <div data-slot="banner" data-severity="error" role="alert">
                <ErrorCircleIcon />
                <span>{error}</span>
                <Button data-variant="ghost" onClick={store.dismissError}>
                  Dismiss
                </Button>
              </div>
            ) : null}
            {environmentState === "reconnecting" ? (
              <div data-slot="banner" data-severity="warning" role="status">
                <WarningIcon />
                Connection lost. Reconnecting… what you miss will be shown when it is back.
              </div>
            ) : null}
            {view !== undefined &&
            environmentState !== undefined &&
            environmentState !== "connected" &&
            environmentState !== "reconnecting" ? (
              <div data-slot="banner" data-severity="warning" role="status">
                <WarningIcon />
                {t("session.awayBanner", {
                  environment:
                    environments.find((h) => h.id === selectedEnvironment)?.name ??
                    selectedEnvironment ??
                    "",
                })}
              </div>
            ) : null}
            {session !== undefined ? (
              <header data-slot="session-header">
                <div data-slot="stack">
                  <h1>{sessionTitle(session)}</h1>
                  <span data-slot="hint">{session.cwd}</span>
                  {view?.conversation.usage !== undefined ? (
                    <span data-slot="usage">{usageLabel(view.conversation.usage)}</span>
                  ) : null}
                </div>
                <div data-slot="row">
                  <Button data-variant="outline" onClick={() => setPanel("settings")}>
                    <SettingsIcon />
                    Settings
                  </Button>
                  <Menu
                    onAction={(value) => {
                      if (value === "rename") setPanel("rename");
                      else if (value === "archive")
                        void store.archiveSession(session.sessionId, !session.archived);
                      else if (value === "delete") setPanel("delete");
                    }}
                  >
                    <MenuTrigger
                      aria-label="Session actions"
                      title="Session actions"
                      data-variant="ghost"
                    >
                      <MoreIcon />
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem value="rename">Rename</MenuItem>
                      <MenuCheckboxItem
                        value="thinking"
                        checked={showThinking}
                        onCheckedChange={(checked) => thinking.set(checked)}
                      >
                        {t("thinking.show")}
                      </MenuCheckboxItem>
                      <MenuItem value="archive">
                        {session.archived ? "Restore" : "Archive"}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem value="delete" data-destructive>
                        Delete
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
              </header>
            ) : null}
            {view !== undefined ? (
              <ConversationView
                key={viewKey(view.environmentId, view.sessionId)}
                sessionKey={viewKey(view.environmentId, view.sessionId)}
                follow={sent}
                conversation={view.conversation}
                loading={view.loading}
                awaitingApproval={activity === "requires_action"}
              />
            ) : (
              <div data-slot="empty">
                {environmentState === "connected" ? (
                  <p>Choose a session, or start a new one.</p>
                ) : environmentState === "connecting" || environmentState === "reconnecting" ? (
                  <p>Connecting to this environment…</p>
                ) : (
                  <div data-slot="empty-block" role="alert">
                    <ErrorCircleIcon size={20} />
                    <p data-slot="empty-title">Not connected to this environment.</p>
                    {environmentError !== undefined ? (
                      <code data-slot="reason">{environmentError}</code>
                    ) : null}
                    {selectedEnvironment !== undefined ? (
                      <Button
                        data-variant="outline"
                        onClick={() => void store.connectEnvironment(selectedEnvironment)}
                      >
                        Retry
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
            )}
            <div data-slot="permissions">
              {(view?.permissions ?? []).map((request) => (
                <PermissionCard
                  key={request.key}
                  request={request}
                  disabled={!connected}
                  onAnswer={store.answerPermission}
                />
              ))}
            </div>
            {view !== undefined ? (
              <Composer
                key={`composer:${viewKey(view.environmentId, view.sessionId)}`}
                environmentId={view.environmentId}
                sessionKey={viewKey(view.environmentId, view.sessionId)}
                canAttach={
                  agents.find((a) => a.id === session?.agent)?.promptCapabilities?.image != null
                }
                enabled={!view.loading}
                connected={connected}
                activity={activity}
                onSent={() => setSent((n) => n + 1)}
              />
            ) : null}
          </main>
        </ResizablePanel>
      </Resizable>

      <SearchDialog
        open={panel === "search"}
        onOpenChange={(open) => !open && close()}
        environments={environments}
        status={status}
        sessions={sessionsByEnvironment}
        onPick={async (environmentId, sessionId) => {
          // An archived session is not in the list unless archived ones are shown: show them, or the pick would select a hidden row.
          if (
            sessionsByEnvironment[environmentId]?.find((s) => s.sessionId === sessionId)?.archived
          )
            setShowArchived(true);
          await store.selectSession(environmentId, sessionId);
        }}
        onNewSession={() => setPanel("new-session")}
      />
      <NewSessionDialog
        open={panel === "new-session"}
        onOpenChange={(open) => !open && close()}
        environments={connectedEnvironments}
        defaultEnvironment={startOn?.environmentId ?? selectedEnvironment}
        defaultCwd={startOn?.cwd}
        agents={agentsByEnvironment}
        readDefaults={readDefaults}
        chooseDirectory={store.chooseDirectory}
        listFolders={store.listFolders}
        status={status}
        onCreate={store.createSession}
      />
      <EnvironmentDialog
        open={panel === "add-environment"}
        onOpenChange={(open) => !open && close()}
        onSave={store.saveEnvironment}
      />
      {defaultsEnvironment !== undefined ? (
        <DefaultsPanel
          open={panel === "defaults"}
          onOpenChange={(open) => !open && close()}
          environmentId={defaultsEnvironment}
          agents={agentsByEnvironment[defaultsEnvironment] ?? []}
        />
      ) : null}
      {session !== undefined ? (
        <>
          <RenameDialog
            open={panel === "rename"}
            onOpenChange={(open) => !open && close()}
            current={sessionTitle(session)}
            onRename={(title) => store.renameSession(session.sessionId, title)}
          />
          <ConfirmDialog
            open={panel === "delete"}
            onOpenChange={(open) => !open && close()}
            title="Delete this session?"
            description="Its whole history is removed for good. This cannot be undone."
            confirmLabel="Delete"
            onConfirm={() => store.deleteSession(session.sessionId)}
          />
          {panel === "settings" ? <SessionSettings onClose={close} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** Keyed by revision: when the defaults change somewhere, the form starts again from the new ones. */
function DefaultsPanel(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  agents: Parameters<typeof AgentDefaultsDialog>[0]["agents"];
}) {
  const store = useAppStore();
  const revision = useAppState((s) => s.defaultsRevision[props.environmentId] ?? 0);
  const read = useCallback(
    (agent: string) => store.readAgentDefaults(props.environmentId, agent),
    [store, props.environmentId],
  );
  return (
    <AgentDefaultsDialog
      key={revision}
      open={props.open}
      onOpenChange={props.onOpenChange}
      agents={props.agents}
      read={read}
      onSave={(agent, config) => store.setAgentDefaults(props.environmentId, agent, config)}
    />
  );
}
