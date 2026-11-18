// The workspace switcher: which folder the sidebar shows, and what is going on in the others. A workspace is a folder on
// one environment (docs/desktop.md); an environment that is not this computer shows as an icon whose name says which one.
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import type { EnvironmentConfig, EnvironmentStatus } from "../api.ts";
import type { Translator } from "../i18n.ts";
import { type Counts, type Elsewhere, URGENCY, urgent, type Workspace } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon, ServerIcon } from "./icons.tsx";
import { ENVIRONMENT_STATE, MARK_WORD, StatusDot } from "./status.tsx";

const ELSEWHERE = {
  "needs-you": "workspace.elsewhere.needsYou",
  running: "workspace.elsewhere.running",
  background: "workspace.elsewhere.background",
  unread: "workspace.elsewhere.unread",
} as const;

/** In words, what the other workspaces have: "2 sessions need you, 1 session is unread". */
export const elsewhereText = (t: Translator["t"], counts: Counts): string => {
  const what = URGENCY.filter((m) => counts[m] > 0).map((m) =>
    t(ELSEWHERE[m], { count: counts[m] }),
  );
  return what.length === 0 ? "" : t("workspace.elsewhere.prefix", { what: what.join(", ") });
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
        {top.count}. {t(MARK_WORD[top.mark])}
      </span>
    </>
  );
}

/** Says a workspace is on another environment, with which, and how it is connected: for the eye and for the reader. */
export function Remote({ environment, state }: { environment: EnvironmentConfig; state: string }) {
  const { t } = useI18n();
  const tip = t("workspace.onState", { environment: environment.name, state });
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
  environments: readonly EnvironmentConfig[];
  status: Record<string, EnvironmentStatus>;
  onChoose: (workspaceKey: string) => void;
};

export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const { t } = useI18n();
  const { workspaces, current, environments, status } = props;
  const environmentOf = (id: string) => environments.find((h) => h.id === id);
  const stateOf = (id: string) => ENVIRONMENT_STATE[status[id]?.state ?? "closed"];
  const away = (id: string) => (status[id]?.state ?? "closed") !== "connected";
  const remote = (id: string) => {
    const environment = environmentOf(id);
    return environment !== undefined && environment.kind !== "local" ? environment : undefined;
  };
  const elsewhere = elsewhereText(t, props.elsewhere.counts);
  const several = new Set(workspaces.map((w) => w.environmentId)).size > 1;
  const groups = [...new Set(workspaces.map((w) => w.environmentId))].map((environmentId) => ({
    environmentId,
    items: workspaces.filter((w) => w.environmentId === environmentId),
  }));
  const item = (w: Workspace) => {
    const environment = remote(w.environmentId);
    return (
      <MenuItem key={w.key} value={w.key} data-away={away(w.environmentId) || undefined}>
        {environment !== undefined ? (
          <Remote environment={environment} state={stateOf(w.environmentId).word} />
        ) : null}
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
  const environment = remote(current.environmentId);
  return (
    <Menu onAction={(value) => props.onChoose(String(value))}>
      <MenuTrigger
        data-variant="ghost"
        data-slot="workspace-switcher"
        data-away={away(current.environmentId) || undefined}
        aria-label={[t("workspace.switch"), current.name, elsewhere]
          .filter((s) => s !== "")
          .join(". ")}
        title={t("workspace.switch")}
      >
        {environment !== undefined ? (
          <Remote environment={environment} state={stateOf(current.environmentId).word} />
        ) : null}
        <span data-slot="workspace-name">{current.name}</span>
        <Badge counts={props.elsewhere.counts} />
        <ChevronDownIcon size={14} />
      </MenuTrigger>
      <MenuContent>
        {several
          ? groups.map((g) => {
              const how = stateOf(g.environmentId);
              return (
                <MenuGroup key={g.environmentId}>
                  <MenuGroupLabel>
                    <StatusDot tone={how.tone} shape={how.shape} />
                    {environmentOf(g.environmentId)?.name ?? g.environmentId} · {how.word}
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
