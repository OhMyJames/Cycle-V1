import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import type { ReactNode } from "react";
import type { HostConfig, HostStatus, SessionSummary } from "../api.ts";
import type { SessionList } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { MoreIcon, PlusIcon, SearchIcon } from "./icons.tsx";
import { type Away, SessionListView } from "./session-list.tsx";
import { HOST_STATE, StatusDot } from "./status.tsx";

export type SidebarProps = {
  hosts: HostConfig[];
  status: Record<string, HostStatus>;
  /** What is shown, grouped and ordered (sessions.ts): the sessions of every host. */
  list: SessionList;
  /** The open session, by its `sessionKey`. */
  selected: string | undefined;
  /** The hosts that are not connected, whose sessions are shown greyed. */
  away: ReadonlyMap<string, Away>;
  showArchived: boolean;
  onSelectSession: (session: SessionSummary) => void;
  onNewSession: () => void;
  onSearch: () => void;
  onAddHost: () => void;
  onRemoveHost: (hostId: string) => void;
  onConnectHost: (hostId: string) => void;
  onToggleArchived: () => void;
  onShowAll: () => void;
  onAgentDefaults: (hostId: string) => void;
  /** Below the rest: the update footer. */
  children?: ReactNode;
};

/** How the shortcut modifier is written here: ⌘ on a Mac, Ctrl+ elsewhere. */
export const MOD = /Mac/.test(globalThis.navigator?.userAgent ?? "") ? "⌘" : "Ctrl+";

export function Sidebar(props: SidebarProps) {
  const { t } = useI18n();
  const connected = props.hosts.filter((h) => props.status[h.id]?.state === "connected");
  const several = props.hosts.length > 1;
  const apart = props.hosts.filter((h) => props.away.has(h.id));
  return (
    <nav data-slot="sidebar" aria-label={t("sessions.label")}>
      <div data-slot="titlebar" aria-hidden="true" />
      <div data-slot="host-bar">
        <span aria-hidden="true" />
        <Menu
          onAction={(value) => {
            const [action, hostId] = String(value).split(":");
            if (value === "add-host") props.onAddHost();
            else if (action === "remove-host" && hostId !== undefined) props.onRemoveHost(hostId);
            else if (action === "agent-defaults" && hostId !== undefined)
              props.onAgentDefaults(hostId);
          }}
        >
          <MenuTrigger aria-label="Host actions" title="Host actions" data-variant="ghost">
            <MoreIcon />
          </MenuTrigger>
          <MenuContent>
            <MenuItem value="add-host">Add host</MenuItem>
            {connected.map((h) => (
              <MenuItem key={h.id} value={`agent-defaults:${h.id}`}>
                {several ? `Agent defaults · ${h.name}` : "Agent defaults"}
              </MenuItem>
            ))}
            {props.hosts.some((h) => h.kind !== "local") ? <MenuSeparator /> : null}
            {props.hosts
              .filter((h) => h.kind !== "local")
              .map((h) => (
                <MenuItem key={h.id} value={`remove-host:${h.id}`}>
                  {`Remove ${h.name}`}
                </MenuItem>
              ))}
          </MenuContent>
        </Menu>
      </div>
      {apart.map((h) => {
        const state = props.status[h.id];
        const how = HOST_STATE[state?.state ?? "closed"];
        return (
          <span
            key={h.id}
            data-slot="host-state"
            data-state={state?.state ?? "closed"}
            role="status"
          >
            <StatusDot tone={how.tone} shape={how.shape} />
            {h.name} · {how.word}
            {(state?.state ?? "closed") === "closed" ? (
              <Button data-variant="ghost" onClick={() => props.onConnectHost(h.id)}>
                Retry
              </Button>
            ) : null}
          </span>
        );
      })}
      <Button
        data-variant="outline"
        disabled={connected.length === 0}
        title={`New session  ${MOD}N`}
        onClick={props.onNewSession}
      >
        <PlusIcon />
        New session
      </Button>
      <Button
        data-variant="ghost"
        data-slot="search-button"
        title={`${t("search.open")}  ${MOD}K`}
        onClick={props.onSearch}
      >
        <SearchIcon />
        {t("search.open")}
        <kbd>{MOD}K</kbd>
      </Button>
      {props.list.order.length > 0 ? (
        <SessionListView
          list={props.list}
          selected={props.selected}
          away={props.away}
          onSelect={props.onSelectSession}
          onShowAll={props.onShowAll}
        />
      ) : (
        <p data-slot="hint">No sessions yet.</p>
      )}
      <Button data-variant="ghost" onClick={props.onToggleArchived}>
        {props.showArchived ? "Hide archived" : "Show archived"}
      </Button>
      {props.children}
    </nav>
  );
}

export { sessionTitle } from "./session-list.tsx";
