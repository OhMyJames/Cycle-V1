import { Listbox, ListboxGroup, ListboxGroupLabel, ListboxItem } from "@ui-sdk/react/listbox";
import type { SessionSummary } from "../api.ts";
import { markOf, type SessionGroup, type SessionList, sessionKey } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { MARK_STYLE, StatusDot } from "./status.tsx";

/** The last part of a path, for a session that has no title yet. */
const place = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

export const sessionTitle = (session: SessionSummary): string => {
  if (session.title !== undefined && session.title !== "") return session.title;
  return place(session.cwd);
};

/** A host that is not connected, as a row of its sessions says it: who, and in what words. */
export type Away = { name: string; word: string };

const MARK_WORD = {
  "needs-you": "mark.needsYou",
  running: "mark.running",
  background: "mark.background",
  unread: "mark.unread",
} as const;

function Row({ session, away }: { session: SessionSummary; away: Away | undefined }) {
  const { t } = useI18n();
  const tip =
    away !== undefined ? t("session.away", { host: away.name, state: away.word }) : undefined;
  // One thing a row says. A session of a host that is away is the last list read: it says nothing.
  const mark = away !== undefined ? undefined : markOf(session);
  const style = mark !== undefined ? MARK_STYLE[mark] : undefined;
  return (
    <ListboxItem
      value={sessionKey(session)}
      data-session={session.sessionId}
      data-host={session.hostId}
      data-archived={session.archived || undefined}
      data-mark={mark}
      data-away={away !== undefined || undefined}
      title={tip}
    >
      <span data-slot="session-dot">
        {style !== undefined ? <StatusDot tone={style.tone} shape={style.shape} /> : null}
      </span>
      {mark !== undefined ? <span data-slot="visually-hidden">{t(MARK_WORD[mark])}. </span> : null}
      <span data-slot="session-title">{sessionTitle(session)}</span>
    </ListboxItem>
  );
}

function Heading({ group }: { group: SessionGroup }) {
  const { t } = useI18n();
  switch (group.kind) {
    case "needs-you":
      return t("sessions.group.needsYou");
    case "running":
      return t("sessions.group.running");
    case "today":
      return t("sessions.group.today");
    case "yesterday":
      return t("sessions.group.yesterday");
    case "earlier":
      return t("sessions.group.earlier");
  }
}

/** What waits on the person, what is running, then the days: one list, so the arrow keys walk all of it. */
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
              <Row key={sessionKey(session)} session={session} away={away.get(session.hostId)} />
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
