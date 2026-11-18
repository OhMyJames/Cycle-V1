import { Listbox, ListboxGroup, ListboxGroupLabel, ListboxItem } from "@ui-sdk/react/listbox";
import type { SessionSummary } from "../api.ts";
import { projectOf, type SessionGroup, type SessionList } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { SESSION_STATE, StatusDot } from "./status.tsx";

/** The last part of a path, for a second line that says where a session works. */
const place = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

export const sessionTitle = (session: SessionSummary): string => {
  if (session.title !== undefined && session.title !== "") return session.title;
  return place(session.cwd);
};

function Row({
  session,
  place: where,
}: {
  session: SessionSummary;
  /** Where the session works, said under its title in the groups that are not a project; absent in a project. */
  place: string | undefined;
}) {
  // The state is told by the dot's colour and shape, and in words by the heading of the group the row is in. An archived
  // session is put away, whatever its state says.
  const doing = session.archived ? undefined : SESSION_STATE[session.state];
  return (
    <ListboxItem
      value={session.sessionId}
      data-session={session.sessionId}
      data-archived={session.archived || undefined}
      data-needs-you={session.state === "requires_action" || undefined}
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
  onSelect,
  onShowAll,
}: {
  list: SessionList;
  selected: string | undefined;
  onSelect: (sessionId: string) => void;
  onShowAll: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Listbox
        aria-label={t("sessions.listLabel")}
        value={selected ?? null}
        onValueChange={(next) => {
          if (typeof next === "string") onSelect(next);
        }}
      >
        {list.groups.map((group) => (
          <ListboxGroup key={group.key} data-kind={group.kind}>
            <ListboxGroupLabel>
              <Heading group={group} />
            </ListboxGroupLabel>
            {group.sessions.map((session) => (
              <Row
                key={session.sessionId}
                session={session}
                place={group.kind === "project" ? undefined : list.names.get(projectOf(session))}
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
