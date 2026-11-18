import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandList,
} from "@ui-sdk/react/command";
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import type { HostConfig, HostStatus, SessionSummary } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { PlusIcon, SearchIcon } from "./icons.tsx";
import { sessionTitle } from "./sidebar.tsx";
import { SESSION_STATE, StatusDot } from "./status.tsx";

const NEW_SESSION = "action:new-session";

const place = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

export type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts: HostConfig[];
  status: Record<string, HostStatus>;
  sessions: Record<string, SessionSummary[]>;
  onPick: (hostId: string, sessionId: string) => void;
  onNewSession: () => void;
};

/**
 * Finds a session on any host the app has read: by what the person remembers of it, which is what each row shows
 * (its title, its folder, its agent, its host). The text of a conversation is not searched: the app holds only what it has
 * opened, and a search of everything has to be done where the history is (the daemon).
 */
export function SearchDialog(props: SearchDialogProps) {
  const { t } = useI18n();
  const several = props.hosts.length > 1;
  // A row's value names it; what it stands for is looked up, not parsed out of the text (an id may hold any character).
  const rows = new Map<string, { hostId: string; sessionId: string }>();
  for (const host of props.hosts)
    for (const s of props.sessions[host.id] ?? [])
      rows.set(`session:${host.id}/${s.sessionId}`, { hostId: host.id, sessionId: s.sessionId });
  const rowValue = (hostId: string, sessionId: string) => `session:${hostId}/${sessionId}`;
  const canCreate = props.hosts.some((h) => props.status[h.id]?.state === "connected");
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogBackdrop />
      <DialogContent data-palette="search">
        <DialogTitle>{t("search.label")}</DialogTitle>
        <Command
          onAction={(value) => {
            props.onOpenChange(false);
            if (value === NEW_SESSION) return props.onNewSession();
            const row = rows.get(value);
            if (row !== undefined) props.onPick(row.hostId, row.sessionId);
          }}
        >
          <div data-slot="row">
            <SearchIcon />
            <CommandInput aria-label={t("search.label")} placeholder={t("search.placeholder")} />
          </div>
          <CommandEmpty>{t("search.empty")}</CommandEmpty>
          <CommandList>
            {props.hosts.flatMap((host) => {
              const ordered = [...(props.sessions[host.id] ?? [])].sort(
                (a, b) => b.lastSeq - a.lastSeq,
              );
              return ordered.map((session) => {
                const doing = SESSION_STATE[session.state];
                return (
                  <CommandItem
                    key={rowValue(host.id, session.sessionId)}
                    value={rowValue(host.id, session.sessionId)}
                  >
                    <CommandItemIcon>
                      {doing !== undefined ? (
                        <StatusDot tone={doing.tone} shape={doing.shape} />
                      ) : null}
                    </CommandItemIcon>
                    <span data-slot="search-row">
                      <span data-slot="search-title">{sessionTitle(session)}</span>
                      <span data-slot="search-meta">
                        <span>{place(session.cwd)}</span>
                        <span>{session.agent}</span>
                        {several ? <span>{t("search.on", { host: host.name })}</span> : null}
                        {session.archived ? <span>{t("search.archived")}</span> : null}
                      </span>
                    </span>
                  </CommandItem>
                );
              });
            })}
            {canCreate ? (
              <CommandGroup>
                <CommandGroupLabel>{t("search.group.actions")}</CommandGroupLabel>
                <CommandItem value={NEW_SESSION}>
                  <CommandItemIcon>
                    <PlusIcon />
                  </CommandItemIcon>
                  {t("search.action.newSession")}
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
