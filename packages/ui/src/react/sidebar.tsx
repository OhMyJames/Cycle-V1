import { Button } from "@ui-sdk/react/button";
import { Listbox, ListboxItem } from "@ui-sdk/react/listbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import type { ReactNode } from "react";
import type { HostConfig, HostStatus, SessionSummary } from "../api.ts";

export const sessionTitle = (session: SessionSummary): string => {
  if (session.title !== undefined && session.title !== "") return session.title;
  const parts = session.cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? session.cwd;
};

const STATE_WORDS: Record<string, string> = {
  running: "working",
  requires_action: "needs you",
  idle: "",
  stopped: "",
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

export function Sidebar(props: SidebarProps) {
  const host = props.hosts.find((h) => h.id === props.selectedHost);
  const state = props.selectedHost !== undefined ? props.status[props.selectedHost] : undefined;
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
        <span data-slot="host-state" data-state={state?.state ?? "closed"} role="status">
          {state?.state === "connected" ? "connected" : (state?.state ?? "not connected")}
        </span>
      </div>
      <div data-slot="row">
        <Button data-variant="outline" onClick={props.onAddHost}>
          Add host
        </Button>
        {host !== undefined && host.kind !== "local" ? (
          <Button data-variant="ghost" onClick={() => props.onRemoveHost(host.id)}>
            Remove
          </Button>
        ) : null}
        <Button data-variant="ghost" onClick={props.onAgentDefaults}>
          Agent defaults
        </Button>
      </div>
      <Button
        data-variant="solid"
        disabled={state?.state !== "connected"}
        onClick={props.onNewSession}
      >
        New session
      </Button>
      <Listbox
        aria-label="Sessions"
        value={props.selectedSession ?? null}
        onValueChange={(next) => {
          if (typeof next === "string") props.onSelectSession(next);
        }}
      >
        {sorted.map((session) => (
          <ListboxItem
            key={session.sessionId}
            value={session.sessionId}
            data-archived={session.archived || undefined}
          >
            <span data-slot="session-title">{sessionTitle(session)}</span>
            <span data-slot="session-state" data-state={session.state}>
              {STATE_WORDS[session.state] ?? ""}
            </span>
          </ListboxItem>
        ))}
      </Listbox>
      {sorted.length === 0 ? <p data-slot="hint">No sessions yet.</p> : null}
      <Button data-variant="ghost" onClick={props.onToggleArchived}>
        {props.showArchived ? "Hide archived" : "Show archived"}
      </Button>
      {props.children}
    </nav>
  );
}
