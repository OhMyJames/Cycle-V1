// The workspace switcher: which folder the sidebar shows, and what is going on in the others. A workspace is a folder on
// one host (docs/desktop.md); a host that is not this computer shows as an icon whose name says which one.
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import type { HostConfig, HostStatus } from "../api.ts";
import type { Translator } from "../i18n.ts";
import type { Counts, Elsewhere, Mark, Workspace } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon, ServerIcon } from "./icons.tsx";
import { HOST_STATE, StatusDot } from "./status.tsx";

const ORDER: readonly Mark[] = ["needs-you", "running", "background", "unread"];
const ELSEWHERE = {
  "needs-you": "workspace.elsewhere.needsYou",
  running: "workspace.elsewhere.running",
  background: "workspace.elsewhere.background",
  unread: "workspace.elsewhere.unread",
} as const;
const WORD = {
  "needs-you": "mark.needsYou",
  running: "mark.running",
  background: "mark.background",
  unread: "mark.unread",
} as const;

/** In words, what the other workspaces have: "2 sessions need you, 1 session is unread". */
export const elsewhereText = (t: Translator["t"], counts: Counts): string => {
  const what = ORDER.filter((m) => counts[m] > 0).map((m) => t(ELSEWHERE[m], { count: counts[m] }));
  return what.length === 0 ? "" : t("workspace.elsewhere.prefix", { what: what.join(", ") });
};

const urgent = (counts: Counts): { mark: Mark; count: number } | undefined => {
  const mark = ORDER.find((m) => counts[m] > 0);
  return mark === undefined ? undefined : { mark, count: counts[mark] };
};

/** A square number: how many sessions are in the most urgent class; the words are for those who do not see it. */
function Badge({ counts }: { counts: Counts }) {
  const { t } = useI18n();
  const top = urgent(counts);
  if (top === undefined) return null;
  return (
    <>
      <span data-slot="badge" data-mark={top.mark} aria-hidden="true">
        {top.count}
      </span>
      <span data-slot="visually-hidden">
        {top.count}. {t(WORD[top.mark])}
      </span>
    </>
  );
}

/** Says a workspace is on another host, with which, and how it is connected: for the eye and for the reader. */
function Remote({ host, state }: { host: HostConfig; state: string }) {
  const { t } = useI18n();
  const tip = t("workspace.onState", { host: host.name, state });
  return (
    <span data-slot="remote" role="img" aria-label={tip} title={tip}>
      <ServerIcon size={14} />
    </span>
  );
}

export type WorkspaceSwitcherProps = {
  workspaces: readonly Workspace[];
  current: Workspace | undefined;
  elsewhere: Elsewhere;
  hosts: readonly HostConfig[];
  status: Record<string, HostStatus>;
  onChoose: (workspaceKey: string) => void;
};

export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const { t } = useI18n();
  const { workspaces, current, hosts, status } = props;
  const hostOf = (id: string) => hosts.find((h) => h.id === id);
  const stateOf = (id: string) => HOST_STATE[status[id]?.state ?? "closed"];
  const away = (id: string) => (status[id]?.state ?? "closed") !== "connected";
  const remote = (id: string) => {
    const host = hostOf(id);
    return host !== undefined && host.kind !== "local" ? host : undefined;
  };
  const elsewhere = elsewhereText(t, props.elsewhere.counts);
  const several = new Set(workspaces.map((w) => w.hostId)).size > 1;
  const groups = [...new Set(workspaces.map((w) => w.hostId))].map((hostId) => ({
    hostId,
    items: workspaces.filter((w) => w.hostId === hostId),
  }));
  const item = (w: Workspace) => {
    const host = remote(w.hostId);
    return (
      <MenuItem key={w.key} value={w.key} data-away={away(w.hostId) || undefined}>
        {host !== undefined ? <Remote host={host} state={stateOf(w.hostId).word} /> : null}
        <span data-slot="workspace-name">{w.name}</span>
        <Badge counts={w.counts} />
      </MenuItem>
    );
  };
  if (current === undefined) {
    return (
      <span data-slot="workspace-switcher" data-empty="">
        {t("workspace.none")}
      </span>
    );
  }
  const host = remote(current.hostId);
  return (
    <Menu onAction={(value) => props.onChoose(String(value))}>
      <MenuTrigger
        data-variant="ghost"
        data-slot="workspace-switcher"
        data-away={away(current.hostId) || undefined}
        aria-label={[t("workspace.switch"), current.name, elsewhere]
          .filter((s) => s !== "")
          .join(". ")}
        title={t("workspace.switch")}
      >
        {host !== undefined ? <Remote host={host} state={stateOf(current.hostId).word} /> : null}
        <span data-slot="workspace-name">{current.name}</span>
        <Badge counts={props.elsewhere.counts} />
        <ChevronDownIcon size={14} />
      </MenuTrigger>
      <MenuContent>
        {several
          ? groups.map((g) => {
              const how = stateOf(g.hostId);
              return (
                <MenuGroup key={g.hostId}>
                  <MenuGroupLabel>
                    <StatusDot tone={how.tone} shape={how.shape} />
                    {hostOf(g.hostId)?.name ?? g.hostId} · {how.word}
                  </MenuGroupLabel>
                  {g.items.map(item)}
                </MenuGroup>
              );
            })
          : workspaces.map(item)}
      </MenuContent>
    </Menu>
  );
}
