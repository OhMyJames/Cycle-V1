import { Button } from "@ui-sdk/react/button";
import { Listbox, ListboxItem } from "@ui-sdk/react/listbox";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import type { ReactNode } from "react";
import type { HostConfig, HostStatus, SessionSummary } from "../api.ts";
import { MoreIcon, PlusIcon } from "./icons.tsx";
import { HOST_STATE, SESSION_STATE, StatusDot } from "./status.tsx";

export const sessionTitle = (session: SessionSummary): string => {
  if (session.title !== undefined && session.title !== "") return session.title;
  const parts = session.cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? session.cwd;
};

export type SidebarProps = {
  hosts: HostConfig[];
  status: Record<string, HostStatus>;
  selectedHost: string | undefined;
  sessions: SessionSummary[];
  selectedSession: string | undefined;
  showArchived: boolean;
  onSelectHost: (hostId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onAddHost: () => void;
  onRemoveHost: (hostId: string) => void;
  onToggleArchived: () => void;
  onAgentDefaults: () => void;
  /** Below the rest: the update footer. */
  children?: ReactNode;
};

/** The last part of a path, for a second line that says where a session works. */
const place = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

export function Sidebar(props: SidebarProps) {
  const host = props.hosts.find((h) => h.id === props.selectedHost);
  const state = props.selectedHost !== undefined ? props.status[props.selectedHost] : undefined;
  const hostState = HOST_STATE[state?.state ?? "closed"];
  const visible = props.sessions.filter((s) => props.showArchived || !s.archived);
  const sorted = [...visible].sort((a, b) => b.lastSeq - a.lastSeq);
  return (
    <nav data-slot="sidebar" aria-label="Sessions">
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
        onClick={props.onNewSession}
      >
        <PlusIcon />
        New session
      </Button>
      {sorted.length > 0 ? (
        <Listbox
          aria-label="Sessions"
          value={props.selectedSession ?? null}
          onValueChange={(next) => {
            if (typeof next === "string") props.onSelectSession(next);
          }}
        >
          {sorted.map((session) => {
            const doing = SESSION_STATE[session.state];
            return (
              <ListboxItem
                key={session.sessionId}
                value={session.sessionId}
                data-archived={session.archived || undefined}
                data-needs-you={session.state === "requires_action" || undefined}
              >
                <span data-slot="session-dot">
                  {doing !== undefined ? <StatusDot tone={doing.tone} shape={doing.shape} /> : null}
                </span>
                <span data-slot="session-main">
                  <span data-slot="session-title">{sessionTitle(session)}</span>
                  <span data-slot="session-meta" data-state={session.state}>
                    {doing?.word ?? place(session.cwd)}
                  </span>
                </span>
              </ListboxItem>
            );
          })}
        </Listbox>
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
