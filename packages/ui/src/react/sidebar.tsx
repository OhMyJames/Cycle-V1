import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import type { ReactNode } from "react";
import type { EnvironmentConfig, EnvironmentStatus, SessionSummary } from "../api.ts";
import type { Elsewhere, SessionList, Workspace } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { MoreIcon, PlugIcon, PlusIcon, SearchIcon } from "./icons.tsx";
import { type Away, SessionListView } from "./session-list.tsx";
import { ENVIRONMENT_STATE, StatusDot } from "./status.tsx";
import { WorkspaceSwitcher } from "./workspace-switcher.tsx";

export type SidebarProps = {
  environments: EnvironmentConfig[];
  status: Record<string, EnvironmentStatus>;
  /** Every workspace, and the one shown (sessions.ts). */
  workspaces: readonly Workspace[];
  current: Workspace | undefined;
  /** What the other workspaces have, for the switcher's badge. */
  elsewhere: Elsewhere;
  onChooseWorkspace: (workspaceKey: string) => void;
  /** What is shown, grouped and ordered (sessions.ts): the sessions of the current workspace. */
  list: SessionList;
  /** The open session, by its `sessionKey`. */
  selected: string | undefined;
  /** The environments that are not connected, whose sessions are shown greyed. */
  away: ReadonlyMap<string, Away>;
  showArchived: boolean;
  onSelectSession: (session: SessionSummary) => void;
  onNewSession: () => void;
  onSearch: () => void;
  /** Opens the connectors: the MCP servers a daemon keeps for every agent. */
  onConnectors?: () => void;
  onAddEnvironment: () => void;
  onRemoveEnvironment: (environmentId: string) => void;
  onConnectEnvironment: (environmentId: string) => void;
  onToggleArchived: () => void;
  onShowAll: () => void;
  onAgentDefaults: (environmentId: string) => void;
  /**
   * Whether the shown workspace's folder is trusted (docs/protocol.md §8 "信任文件夹"): absent when its daemon cannot say,
   * or has not yet. With it, the menu offers to change it.
   */
  trust?: boolean | null | undefined;
  onTrust?: (trusted: boolean) => void;
  /** Below the rest: the update footer. */
  children?: ReactNode;
};

/** How the shortcut modifier is written here: ⌘ on a Mac, Ctrl+ elsewhere. */
export const MOD = /Mac/.test(globalThis.navigator?.userAgent ?? "") ? "⌘" : "Ctrl+";

export function Sidebar(props: SidebarProps) {
  const { t } = useI18n();
  const connected = props.environments.filter((h) => props.status[h.id]?.state === "connected");
  const several = props.environments.length > 1;
  const apart = props.environments.filter((h) => props.away.has(h.id));
  return (
    <nav data-slot="sidebar" aria-label={t("sessions.label")}>
      <div data-slot="titlebar" aria-hidden="true" />
      <div data-slot="sidebar-actions">
        <Button
          data-variant="ghost"
          data-kind="sidebar-action"
          disabled={connected.length === 0}
          aria-label={t("sidebar.newSession")}
          title={`${t("sidebar.newSession")}  ${MOD}N`}
          onClick={props.onNewSession}
        >
          <PlusIcon />
          {t("sidebar.newSession")}
          <kbd>{MOD}N</kbd>
        </Button>
        <Button
          data-variant="ghost"
          data-kind="sidebar-action"
          aria-label={t("search.open")}
          title={`${t("search.open")}  ${MOD}K`}
          onClick={props.onSearch}
        >
          <SearchIcon />
          {t("search.open")}
          <kbd>{MOD}K</kbd>
        </Button>
        {props.onConnectors !== undefined ? (
          <Button data-variant="ghost" data-kind="sidebar-action" onClick={props.onConnectors}>
            <PlugIcon />
            {t("connectors.open")}
          </Button>
        ) : null}
      </div>
      {/* Below the actions, above the list it chooses: the switcher names what the list shows. */}
      <div data-slot="environment-bar">
        <WorkspaceSwitcher
          workspaces={props.workspaces}
          current={props.current}
          elsewhere={props.elsewhere}
          environments={props.environments}
          status={props.status}
          onChoose={props.onChooseWorkspace}
        />
        <Menu
          onAction={(value) => {
            const [action, environmentId] = String(value).split(":");
            if (value === "add-environment") props.onAddEnvironment();
            else if (action === "remove-environment" && environmentId !== undefined)
              props.onRemoveEnvironment(environmentId);
            else if (action === "agent-defaults" && environmentId !== undefined)
              props.onAgentDefaults(environmentId);
            else if (value === "trust") props.onTrust?.(true);
            else if (value === "untrust") props.onTrust?.(false);
          }}
        >
          <MenuTrigger
            aria-label="Environment actions"
            title="Environment actions"
            data-variant="ghost"
          >
            <MoreIcon />
          </MenuTrigger>
          <MenuContent>
            {props.trust !== undefined && props.onTrust !== undefined ? (
              <>
                <MenuItem value={props.trust === true ? "untrust" : "trust"}>
                  {t(props.trust === true ? "trust.untrust" : "trust.trust")}
                </MenuItem>
                <MenuSeparator />
              </>
            ) : null}
            <MenuItem value="add-environment">Add environment</MenuItem>
            {connected.map((h) => (
              <MenuItem key={h.id} value={`agent-defaults:${h.id}`}>
                {several ? `Agent defaults · ${h.name}` : "Agent defaults"}
              </MenuItem>
            ))}
            {props.environments.some((h) => h.kind !== "local") ? <MenuSeparator /> : null}
            {props.environments
              .filter((h) => h.kind !== "local")
              .map((h) => (
                <MenuItem key={h.id} value={`remove-environment:${h.id}`}>
                  {`Remove ${h.name}`}
                </MenuItem>
              ))}
          </MenuContent>
        </Menu>
      </div>
      {apart.map((h) => {
        const state = props.status[h.id];
        const how = ENVIRONMENT_STATE[state?.state ?? "closed"];
        return (
          <span
            key={h.id}
            data-slot="environment-state"
            data-state={state?.state ?? "closed"}
            role="status"
          >
            <StatusDot tone={how.tone} shape={how.shape} />
            <span data-slot="environment-name" title={`${h.name} · ${how.word}`}>
              {h.name} · {how.word}
            </span>
            {state?.error !== undefined && (state?.state ?? "closed") === "closed" ? (
              <span data-slot="hint" title={state.error}>
                {state.error}
              </span>
            ) : null}
            {(state?.state ?? "closed") === "closed" ? (
              <Button data-variant="ghost" onClick={() => props.onConnectEnvironment(h.id)}>
                Retry
              </Button>
            ) : null}
          </span>
        );
      })}
      {/* Only the list scrolls: what is above it and the footer stay where the hand expects them. */}
      <div data-slot="sidebar-scroll">
        {props.list.order.length > 0 ? (
          <SessionListView
            list={props.list}
            selected={props.selected}
            away={props.away}
            onSelect={props.onSelectSession}
            onShowAll={props.onShowAll}
          />
        ) : (
          <p data-slot="hint">
            {t(
              connected.length === 0 && props.environments.length > 0
                ? "sessions.unavailable"
                : "sessions.empty",
            )}
          </p>
        )}
        <button type="button" data-slot="list-toggle" onClick={props.onToggleArchived}>
          {t(props.showArchived ? "sessions.hideArchived" : "sessions.showArchived")}
        </button>
      </div>
      {props.children != null ? <div data-slot="sidebar-footer">{props.children}</div> : null}
    </nav>
  );
}

export { sessionTitle } from "./session-list.tsx";
