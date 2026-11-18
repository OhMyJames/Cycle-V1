import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { useCallback, useState } from "react";
import { usageLabel } from "../model/index.ts";
import { viewKey } from "../store/index.ts";
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
import { PermissionCard } from "./permission.tsx";
import { Sidebar, sessionTitle } from "./sidebar.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { UpdateBanner, UpdateFooter } from "./update.tsx";

type Panel = "none" | "new-session" | "add-host" | "defaults" | "rename" | "delete" | "settings";

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

  const sessions = selectedHost !== undefined ? (sessionsByHost[selectedHost] ?? []) : [];
  const agents = selectedHost !== undefined ? (agentsByHost[selectedHost] ?? []) : [];
  const session = sessions.find((s) => s.sessionId === selectedSession);
  const view =
    selectedHost !== undefined && selectedSession !== undefined
      ? views[viewKey(selectedHost, selectedSession)]
      : undefined;
  const hostState = selectedHost !== undefined ? status[selectedHost]?.state : undefined;
  const readDefaults = useCallback(
    (agent: string) =>
      selectedHost !== undefined
        ? store.readAgentDefaults(selectedHost, agent)
        : Promise.resolve(undefined),
    [store, selectedHost],
  );
  const close = () => setPanel("none");

  if (!ready) return <div data-slot="starting">Starting…</div>;

  return (
    <div data-slot="app">
      <Sidebar
        hosts={hosts}
        status={status}
        selectedHost={selectedHost}
        sessions={sessions}
        selectedSession={selectedSession}
        showArchived={showArchived}
        onSelectHost={(id) => void store.selectHost(id)}
        onSelectSession={(id) => void store.selectSession(id)}
        onNewSession={() => setPanel("new-session")}
        onAddHost={() => setPanel("add-host")}
        onRemoveHost={(id) => void store.removeHost(id)}
        onToggleArchived={() => setShowArchived((v) => !v)}
        onAgentDefaults={() => setPanel("defaults")}
      >
        <UpdateFooter />
      </Sidebar>
      <main data-slot="main">
        <UpdateBanner />
        {error !== undefined ? (
          <div data-slot="banner" data-severity="error" role="alert">
            <span>{error}</span>
            <Button data-variant="ghost" onClick={store.dismissError}>
              Dismiss
            </Button>
          </div>
        ) : null}
        {hostState === "reconnecting" ? (
          <div data-slot="banner" data-severity="warning" role="status">
            Connection lost. Reconnecting… what you miss will be shown when it is back.
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
                Settings
              </Button>
              <Button data-variant="outline" onClick={() => setPanel("rename")}>
                Rename
              </Button>
              <Button
                data-variant="outline"
                onClick={() => void store.archiveSession(session.sessionId, !session.archived)}
              >
                {session.archived ? "Restore" : "Archive"}
              </Button>
              <Button data-variant="outline" onClick={() => setPanel("delete")}>
                Delete
              </Button>
            </div>
          </header>
        ) : null}
        {view !== undefined ? (
          <ConversationView conversation={view.conversation} loading={view.loading} />
        ) : (
          <div data-slot="empty">
            {hostState === "connected"
              ? "Choose a session, or start a new one."
              : "Not connected to this host."}
          </div>
        )}
        <div data-slot="permissions">
          {(view?.permissions ?? []).map((request) => (
            <PermissionCard key={request.key} request={request} onAnswer={store.answerPermission} />
          ))}
        </div>
        <Composer
          enabled={view !== undefined && !view.loading}
          working={view !== undefined && view.conversation.status !== "idle"}
          onSend={store.send}
          onStop={store.cancel}
        />
      </main>

      <NewSessionDialog
        open={panel === "new-session"}
        onOpenChange={(open) => !open && close()}
        agents={agents}
        readDefaults={readDefaults}
        chooseDirectory={store.chooseDirectory}
        onCreate={store.createSession}
      />
      <HostDialog
        open={panel === "add-host"}
        onOpenChange={(open) => !open && close()}
        onSave={store.saveHost}
      />
      {selectedHost !== undefined ? (
        <DefaultsPanel
          open={panel === "defaults"}
          onOpenChange={(open) => !open && close()}
          hostId={selectedHost}
          agents={agents}
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
