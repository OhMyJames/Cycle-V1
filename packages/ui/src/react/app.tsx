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
  HostDialog,
  NewSessionDialog,
  RenameDialog,
} from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { ErrorCircleIcon, MoreIcon, SettingsIcon, WarningIcon } from "./icons.tsx";
import { useInFront } from "./in-front.ts";
import { PermissionCard } from "./permission.tsx";
import { SearchDialog } from "./search.tsx";
import type { Away } from "./session-list.tsx";
import { MOD, Sidebar, sessionTitle } from "./sidebar.tsx";
import { HOST_STATE } from "./status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { DaemonBanner, UpdateBanner, UpdateFooter } from "./update.tsx";

type Panel =
  | "none"
  | "new-session"
  | "add-host"
  | "defaults"
  | "rename"
  | "delete"
  | "settings"
  | "search";

function SessionSettings({ onClose }: { onClose: () => void }) {
  const store = useAppStore();
  const host = useAppState((s) => s.selectedHost);
  const sessionId = useAppState((s) => s.selectedSession);
  const sessions = useAppState((s) => (host !== undefined ? s.sessions[host] : undefined));
  const agents = useAppState((s) => (host !== undefined ? s.agents[host] : undefined));
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
  const hosts = useAppState((s) => s.hosts);
  const status = useAppState((s) => s.status);
  const selectedHost = useAppState((s) => s.selectedHost);
  const selectedSession = useAppState((s) => s.selectedSession);
  const sessionsByHost = useAppState((s) => s.sessions);
  const agentsByHost = useAppState((s) => s.agents);
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

  // The sessions of every host, in one list; what is open is on the host `selectedHost` names.
  const sessions = useMemo(
    () => hosts.flatMap((h) => sessionsByHost[h.id] ?? []),
    [hosts, sessionsByHost],
  );
  const agents = selectedHost !== undefined ? (agentsByHost[selectedHost] ?? []) : [];
  const session = sessions.find(
    (s) => s.hostId === selectedHost && s.sessionId === selectedSession,
  );
  const [defaultsHost, setDefaultsHost] = useState<string | undefined>(undefined);
  const connectedHosts = hosts.filter((h) => status[h.id]?.state === "connected");
  // A host that is not connected: its sessions are the last it gave, and are shown greyed.
  const away = useMemo(() => {
    const map = new Map<string, Away>();
    for (const h of hosts) {
      const state = status[h.id]?.state ?? "closed";
      if (state !== "connected") map.set(h.id, { name: h.name, word: HOST_STATE[state].word });
    }
    return map;
  }, [hosts, status]);
  const view =
    selectedHost !== undefined && selectedSession !== undefined
      ? views[viewKey(selectedHost, selectedSession)]
      : undefined;
  const hostState = selectedHost !== undefined ? status[selectedHost]?.state : undefined;
  const hostError = selectedHost !== undefined ? status[selectedHost]?.error : undefined;
  const readDefaults = useCallback(
    (hostId: string, agent: string) => store.readAgentDefaults(hostId, agent),
    [store],
  );
  const close = () => setPanel("none");
  const [layout] = useState(createResizableController);
  // The workspaces, and the one the sidebar shows; the list on screen and the keys that walk it (Cmd+[ and Cmd+]) are one thing.
  const hostLabels = useMemo(
    () => hosts.map((h) => ({ id: h.id, name: h.name, local: h.kind === "local" })),
    [hosts],
  );
  const awayHosts = useMemo(() => new Set(away.keys()), [away]);
  const workspaces = useMemo(
    () => workspacesOf(sessions, { hosts: hostLabels, away: awayHosts, showArchived }),
    [sessions, hostLabels, awayHosts, showArchived],
  );
  const openKey = session !== undefined ? sessionKey(session) : undefined;
  const current = currentWorkspace(workspaces, {
    chosen: chosen !== undefined && chosen.on === openKey ? chosen.workspace : undefined,
    open: session,
  });
  const elsewhere = useMemo(() => elsewhereOf(workspaces, current), [workspaces, current]);
  const list = useMemo(
    () =>
      sessionList(current?.sessions ?? [], {
        showAll,
        selected: openKey,
        away: awayHosts,
        now: new Date(),
      }),
    [current, showAll, openKey, awayHosts],
  );

  // What is on screen has been seen: the daemon is told, so the mark goes and stays gone (also on another client).
  // Only while the app is in front, and only for a daemon that says there is news.
  const inFront = useInFront();
  const unreadOpen = session?.unread === true;
  const openHost = session?.hostId;
  const openId = session?.sessionId;
  useEffect(() => {
    if (!unreadOpen || !inFront || openHost === undefined || openId === undefined) return;
    if (status[openHost]?.state !== "connected") return;
    void store.markRead(openHost, openId);
  }, [unreadOpen, inFront, openHost, openId, status, store]);

  const working = view !== undefined && view.conversation.status !== "idle";
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
      else if (key === "n" && connectedHosts.length > 0) run(() => setPanel("new-session"));
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
      else if (key === "." && working && hostState === "connected") run(() => void store.cancel());
      else if (
        key === "Enter" &&
        typing === null &&
        hostState === "connected" &&
        firstAllow !== undefined &&
        view?.permissions[0] !== undefined
      ) {
        const request = view.permissions[0];
        run(() => void store.answerPermission(request.key, firstAllow.optionId));
      } else if (key === "[" || key === "]") {
        const at = session === undefined ? -1 : list.order.indexOf(session);
        // A row on a host that is away and was never opened cannot be opened: the walk goes past it.
        const step = key === "]" ? 1 : -1;
        let to = at + step;
        while (list.order[to] !== undefined && away.has(list.order[to]?.hostId ?? "")) to += step;
        const next = list.order[to];
        if (next !== undefined) run(() => void store.selectSession(next.hostId, next.sessionId));
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
            hosts={hosts}
            status={status}
            workspaces={workspaces}
            current={current}
            elsewhere={elsewhere}
            onChooseWorkspace={(workspace) => setChosen({ workspace, on: openKey })}
            list={list}
            selected={openKey}
            away={away}
            showArchived={showArchived}
            onSelectSession={(chosen) => void store.selectSession(chosen.hostId, chosen.sessionId)}
            onNewSession={() => setPanel("new-session")}
            onSearch={() => setPanel("search")}
            onAddHost={() => setPanel("add-host")}
            onRemoveHost={(id) => void store.removeHost(id)}
            onConnectHost={(id) => void store.connectHost(id)}
            onToggleArchived={() => setShowArchived((v) => !v)}
            onShowAll={() => setShowAll(true)}
            onAgentDefaults={(id) => {
              setDefaultsHost(id);
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
            {selectedHost !== undefined ? <DaemonBanner hostId={selectedHost} /> : null}
            {error !== undefined ? (
              <div data-slot="banner" data-severity="error" role="alert">
                <ErrorCircleIcon />
                <span>{error}</span>
                <Button data-variant="ghost" onClick={store.dismissError}>
                  Dismiss
                </Button>
              </div>
            ) : null}
            {hostState === "reconnecting" ? (
              <div data-slot="banner" data-severity="warning" role="status">
                <WarningIcon />
                Connection lost. Reconnecting… what you miss will be shown when it is back.
              </div>
            ) : null}
            {view !== undefined &&
            hostState !== undefined &&
            hostState !== "connected" &&
            hostState !== "reconnecting" ? (
              <div data-slot="banner" data-severity="warning" role="status">
                <WarningIcon />
                {t("session.awayBanner", {
                  host: hosts.find((h) => h.id === selectedHost)?.name ?? selectedHost ?? "",
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
                key={viewKey(view.hostId, view.sessionId)}
                sessionKey={viewKey(view.hostId, view.sessionId)}
                follow={sent}
                conversation={view.conversation}
                loading={view.loading}
              />
            ) : (
              <div data-slot="empty">
                {hostState === "connected" ? (
                  <p>Choose a session, or start a new one.</p>
                ) : hostState === "connecting" || hostState === "reconnecting" ? (
                  <p>Connecting to this host…</p>
                ) : (
                  <div data-slot="empty-block" role="alert">
                    <ErrorCircleIcon size={20} />
                    <p data-slot="empty-title">Not connected to this host.</p>
                    {hostError !== undefined ? <code data-slot="reason">{hostError}</code> : null}
                    {selectedHost !== undefined ? (
                      <Button
                        data-variant="outline"
                        onClick={() => void store.connectHost(selectedHost)}
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
                  onAnswer={store.answerPermission}
                />
              ))}
            </div>
            {view !== undefined ? (
              <Composer
                key={`composer:${viewKey(view.hostId, view.sessionId)}`}
                hostId={view.hostId}
                sessionKey={viewKey(view.hostId, view.sessionId)}
                canAttach={
                  agents.find((a) => a.id === session?.agent)?.promptCapabilities?.image != null
                }
                enabled={!view.loading && hostState === "connected"}
                onSent={() => setSent((n) => n + 1)}
              />
            ) : null}
          </main>
        </ResizablePanel>
      </Resizable>

      <SearchDialog
        open={panel === "search"}
        onOpenChange={(open) => !open && close()}
        hosts={hosts}
        status={status}
        sessions={sessionsByHost}
        onPick={async (hostId, sessionId) => {
          // An archived session is not in the list unless archived ones are shown: show them, or the pick would select a hidden row.
          if (sessionsByHost[hostId]?.find((s) => s.sessionId === sessionId)?.archived)
            setShowArchived(true);
          await store.selectSession(hostId, sessionId);
        }}
        onNewSession={() => setPanel("new-session")}
      />
      <NewSessionDialog
        open={panel === "new-session"}
        onOpenChange={(open) => !open && close()}
        hosts={connectedHosts}
        defaultHost={current?.hostId ?? selectedHost}
        defaultCwd={current?.cwd}
        agents={agentsByHost}
        readDefaults={readDefaults}
        chooseDirectory={store.chooseDirectory}
        onCreate={store.createSession}
      />
      <HostDialog
        open={panel === "add-host"}
        onOpenChange={(open) => !open && close()}
        onSave={store.saveHost}
      />
      {defaultsHost !== undefined ? (
        <DefaultsPanel
          open={panel === "defaults"}
          onOpenChange={(open) => !open && close()}
          hostId={defaultsHost}
          agents={agentsByHost[defaultsHost] ?? []}
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
  hostId: string;
  agents: Parameters<typeof AgentDefaultsDialog>[0]["agents"];
}) {
  const store = useAppStore();
  const revision = useAppState((s) => s.defaultsRevision[props.hostId] ?? 0);
  const read = useCallback(
    (agent: string) => store.readAgentDefaults(props.hostId, agent),
    [store, props.hostId],
  );
  return (
    <AgentDefaultsDialog
      key={revision}
      open={props.open}
      onOpenChange={props.onOpenChange}
      agents={props.agents}
      read={read}
      onSave={(agent, config) => store.setAgentDefaults(props.hostId, agent, config)}
    />
  );
}
