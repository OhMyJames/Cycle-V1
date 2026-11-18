import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import type { ReactNode } from "react";
import type { HostConfig, HostStatus } from "../api.ts";
import type { SessionList } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { MoreIcon, PlusIcon, SearchIcon } from "./icons.tsx";
import { SessionListView } from "./session-list.tsx";
import { HOST_STATE, StatusDot } from "./status.tsx";

export type SidebarProps = {
  hosts: HostConfig[];
  status: Record<string, HostStatus>;
  selectedHost: string | undefined;
  /** What is shown, grouped and ordered (sessions.ts). */
  list: SessionList;
  selectedSession: string | undefined;
  showArchived: boolean;
  onSelectHost: (hostId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onSearch: () => void;
  onAddHost: () => void;
  onRemoveHost: (hostId: string) => void;
  onToggleArchived: () => void;
  onShowAll: () => void;
  onAgentDefaults: () => void;
  /** Below the rest: the update footer. */
  children?: ReactNode;
};

/** How the shortcut modifier is written here: ⌘ on a Mac, Ctrl+ elsewhere. */
export const MOD = /Mac/.test(globalThis.navigator?.userAgent ?? "") ? "⌘" : "Ctrl+";

export function Sidebar(props: SidebarProps) {
  const { t } = useI18n();
  const host = props.hosts.find((h) => h.id === props.selectedHost);
  const state = props.selectedHost !== undefined ? props.status[props.selectedHost] : undefined;
  const hostState = HOST_STATE[state?.state ?? "closed"];
  return (
    <nav data-slot="sidebar" aria-label="Sessions">
      <div data-slot="titlebar" aria-hidden="true" />
      <div data-slot="host-bar">
        <Select
          items={props.hosts.map((h) => ({ value: h.id, label: h.name }))}
          value={props.selectedHost ?? null}
          onValueChange={(next) => {
            if (typeof next === "string") props.onSelectHost(next);
          }}
        >
          <SelectTrigger aria-label="Host">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {props.hosts.map((h) => (
              <SelectItem key={h.id} value={h.id}>
                {h.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Menu
          onAction={(value) => {
            if (value === "add-host") props.onAddHost();
            else if (value === "remove-host" && host !== undefined) props.onRemoveHost(host.id);
            else if (value === "agent-defaults") props.onAgentDefaults();
          }}
        >
          <MenuTrigger aria-label="Host actions" title="Host actions" data-variant="ghost">
            <MoreIcon />
          </MenuTrigger>
          <MenuContent>
            <MenuItem value="add-host">Add host</MenuItem>
            <MenuItem value="agent-defaults">Agent defaults</MenuItem>
            {host !== undefined && host.kind !== "local" ? (
              <>
                <MenuSeparator />
                <MenuItem value="remove-host">Remove host</MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      </div>
      <span data-slot="host-state" data-state={state?.state ?? "closed"} role="status">
        <StatusDot tone={hostState.tone} shape={hostState.shape} />
        {hostState.word}
      </span>
      <Button
        data-variant="outline"
        disabled={state?.state !== "connected"}
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
          selected={props.selectedSession}
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
