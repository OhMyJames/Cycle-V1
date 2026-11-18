import { Listbox, ListboxGroup, ListboxGroupLabel, ListboxItem } from "@ui-sdk/react/listbox";
import type { SessionSummary } from "../api.ts";
import { projectKey, type SessionGroup, type SessionList, sessionKey } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { SESSION_STATE, StatusDot } from "./status.tsx";

/** The last part of a path, for a second line that says where a session works. */
const place = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

export const sessionTitle = (session: SessionSummary): string => {
  if (session.title !== undefined && session.title !== "") return session.title;
  return place(session.cwd);
};

/** A host that is not connected, as a row of its sessions says it: who, and in what words. */
export type Away = { name: string; word: string };

function Row({
  session,
  place: where,
  away,
}: {
  session: SessionSummary;
  /** Set when the session's host is not connected: the row is the last one read, and is shown greyed. */
  away: Away | undefined;
  /** Where the session works, said under its title in the groups that are not a project; absent in a project. */
  place: string | undefined;
}) {
  const { t } = useI18n();
  const tip =
    away !== undefined ? t("session.away", { host: away.name, state: away.word }) : undefined;
  // The state is told by the dot's colour and shape, and in words by the heading of the group the row is in. An archived
  // session is put away, whatever its state says.
  const doing = session.archived || away !== undefined ? undefined : SESSION_STATE[session.state];
  return (
    <ListboxItem
      value={sessionKey(session)}
      data-session={session.sessionId}
      data-host={session.hostId}
      data-archived={session.archived || undefined}
      data-needs-you={(away === undefined && session.state === "requires_action") || undefined}
      data-away={away !== undefined || undefined}
      title={tip}
    >
      <span data-slot="session-dot">
        {doing !== undefined ? <StatusDot tone={doing.tone} shape={doing.shape} /> : null}
      </span>
      <span data-slot="session-main">
        <span data-slot="session-title">{sessionTitle(session)}</span>
        <span data-slot="session-meta" data-state={session.state}>
          {where}
        </span>
      </span>
    </ListboxItem>
  );
}

function Heading({ group }: { group: SessionGroup }) {
  const { t } = useI18n();
  return group.kind === "needs-you"
    ? t("sessions.group.needsYou")
    : group.kind === "working"
      ? t("sessions.group.working")
      : group.label === ""
        ? t("sessions.noFolder")
        : group.label;
}

/** What waits on the person, what is working, then the projects: one list, so the arrow keys walk all of it. */
export function SessionListView({
  list,
  selected,
  away,
  onSelect,
  onShowAll,
}: {
  list: SessionList;
  /** The open session, by its `sessionKey`. */
  selected: string | undefined;
  /** The hosts that are not connected, by id. */
  away: ReadonlyMap<string, Away>;
  onSelect: (session: SessionSummary) => void;
  onShowAll: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Listbox
        aria-label={t("sessions.listLabel")}
        value={selected ?? null}
        onValueChange={(next) => {
          const chosen = list.order.find((s) => sessionKey(s) === next);
          if (chosen !== undefined) onSelect(chosen);
        }}
      >
        {list.groups.map((group) => (
          <ListboxGroup key={group.key} data-kind={group.kind}>
            <ListboxGroupLabel>
              <Heading group={group} />
            </ListboxGroupLabel>
            {group.sessions.map((session) => (
              <Row
                key={sessionKey(session)}
                session={session}
                away={away.get(session.hostId)}
                place={group.kind === "project" ? undefined : list.names.get(projectKey(session))}
              />
            ))}
          </ListboxGroup>
        ))}
      </Listbox>
      {list.hidden > 0 ? (
        <button type="button" data-slot="show-all" onClick={onShowAll}>
          {t("sessions.showAll", { count: list.hidden })}
        </button>
      ) : null}
    </>
  );
}
