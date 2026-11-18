import { Listbox, ListboxGroup, ListboxGroupLabel, ListboxItem } from "@ui-sdk/react/listbox";
import type { SessionSummary } from "../api.ts";
import type { SessionGroup, SessionList } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { SESSION_STATE, StatusDot } from "./status.tsx";

/** The last part of a path, for a second line that says where a session works. */
const place = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

export const sessionTitle = (session: SessionSummary): string => {
  if (session.title !== undefined && session.title !== "") return session.title;
  return place(session.cwd);
};

function Row({ session, named }: { session: SessionSummary; named: boolean }) {
  const doing = SESSION_STATE[session.state];
  return (
    <ListboxItem
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
          {doing?.word}
          {/* Under a project, the project is the heading; in the groups above, it says where the session is. */}
          {named ? <span data-slot="session-place">{place(session.cwd)}</span> : null}
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
        aria-label={t("sessions.label")}
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
              <Row key={session.sessionId} session={session} named={group.kind !== "project"} />
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
