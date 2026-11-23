// The Diff tab of the right panel (CYCL-95), in two views that each say what they cover
// (.agents/notes/2026-11-22-files-and-diff-sources.md):
// - This session: the edits the agent made with its file tools, by turn, from the conversation itself. Changes made by
//   commands are not in it, and it says so.
// - Workspace: the session's folder against HEAD, as the daemon's git says it (docs/protocol.md §8 "工作区的改动"),
//   in a trusted repository only. Whoever made them.
import { Button } from "@ui-sdk/react/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFile, WorkspacePatch, WorkspaceStatus } from "../api.ts";
import { insideFolder } from "../files-view.ts";
import { diffLines, type SessionEdit, sessionEdits, type TurnEdits } from "../model/index.ts";
import { reveal } from "../reveal.ts";
import { viewKey } from "../store/index.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon, RefreshIcon } from "./icons.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";
import { DiffView } from "./tool.tsx";

export type DiffMode = "session" | "workspace";

/** A path as the panel shows it: inside the session's folder, relative to it; elsewhere, as the agent gave it. */
const shownPath = (path: string | undefined, cwd: string | undefined): string | undefined =>
  path === undefined
    ? undefined
    : ((cwd !== undefined ? insideFolder(path, cwd) : undefined) ?? path);

type Load<T> =
  | { state: "loading" }
  | { state: "ok"; value: T }
  | { state: "error"; reason: string };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function Diff() {
  const { t } = useI18n();
  const store = useAppStore();
  const environmentId = useAppState((s) => s.selectedEnvironment);
  const sessionId = useAppState((s) => s.selectedSession);
  const key =
    environmentId !== undefined && sessionId !== undefined
      ? viewKey(environmentId, sessionId)
      : undefined;
  const conversation = useAppState((s) =>
    key !== undefined ? s.views[key]?.conversation : undefined,
  );
  const session = useAppState((s) =>
    environmentId !== undefined
      ? s.sessions[environmentId]?.find((x) => x.sessionId === sessionId)
      : undefined,
  );
  const canWorkspace = useAppState((s) =>
    environmentId !== undefined ? s.status[environmentId]?.capabilities?.diff === true : false,
  );
  const [mode, setMode] = useState<DiffMode>("session");
  const shown: DiffMode = canWorkspace ? mode : "session";

  if (key === undefined || environmentId === undefined || sessionId === undefined)
    return (
      <div data-slot="diff">
        <StateBlock tone="empty" size="inline" title={t("overview.noSession")} />
      </div>
    );
  const running = session?.state === "running" || session?.state === "requires_action";
  return (
    <div data-slot="diff">
      {canWorkspace ? (
        <div data-slot="diff-modes">
          <SegmentedControl
            value={shown}
            aria-label={t("diff.view")}
            onValueChange={(next) => {
              if ((next === "session" || next === "workspace") && next !== shown) {
                setMode(next);
                store.track("diff_view_changed", { view: next });
              }
            }}
          >
            <SegmentedControlIndicator />
            <SegmentedControlItem value="session">{t("diff.view.session")}</SegmentedControlItem>
            <SegmentedControlItem value="workspace">
              {t("diff.view.workspace")}
            </SegmentedControlItem>
          </SegmentedControl>
        </div>
      ) : null}
      {shown === "session" ? (
        <SessionView sessionKey={key} conversation={conversation} cwd={session?.cwd} />
      ) : (
        // One per session: another session's workspace and turns are its own.
        <WorkspaceView
          key={key}
          environmentId={environmentId}
          sessionId={sessionId}
          running={running}
        />
      )}
    </div>
  );
}

function SessionView({
  sessionKey,
  conversation,
  cwd,
}: {
  sessionKey: string;
  conversation: Parameters<typeof sessionEdits>[0] | undefined;
  cwd: string | undefined;
}) {
  const { t } = useI18n();
  const turns = useMemo(
    () => (conversation !== undefined ? sessionEdits(conversation) : []),
    [conversation],
  );
  if (conversation === undefined)
    return <StateBlock tone="loading" size="inline" title={t("overview.loading")} />;
  return (
    <>
      <p data-slot="diff-scope">{t("diff.session.scope")}</p>
      {turns.length === 0 ? (
        <StateBlock
          tone="empty"
          size="inline"
          title={t("diff.session.empty")}
          body={t("diff.session.emptyBody")}
        />
      ) : (
        turns.map((turn) => (
          <TurnSection key={turn.turn} turn={turn} sessionKey={sessionKey} cwd={cwd} />
        ))
      )}
    </>
  );
}

function TurnSection({
  turn,
  sessionKey,
  cwd,
}: {
  turn: TurnEdits;
  sessionKey: string;
  cwd: string | undefined;
}) {
  const { t } = useI18n();
  return (
    <section data-slot="diff-turn">
      <div data-slot="diff-turn-head">
        <h2 title={turn.prompt}>{turn.prompt ?? t("diff.turn.untitled")}</h2>
        <Counts additions={turn.additions} deletions={turn.deletions} />
      </div>
      <ul data-slot="diff-files">
        {turn.edits.map((edit) => (
          <li key={edit.toolId}>
            <EditRow edit={edit} sessionKey={sessionKey} cwd={cwd} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Counts({
  additions,
  deletions,
}: {
  additions: number | undefined;
  deletions: number | undefined;
}) {
  const { t } = useI18n();
  if (additions === undefined || deletions === undefined) return null;
  return (
    <span
      data-slot="diff-counts"
      title={t("tool.facts.diff", { added: additions, removed: deletions })}
    >
      <span data-slot="diff-added" aria-hidden="true">
        +{additions}
      </span>
      <span data-slot="diff-removed" aria-hidden="true">
        −{deletions}
      </span>
      <span data-slot="visually-hidden">
        {t("tool.facts.diff", { added: additions, removed: deletions })}
      </span>
    </span>
  );
}

function EditRow({
  edit,
  sessionKey,
  cwd,
}: {
  edit: SessionEdit;
  sessionKey: string;
  cwd: string | undefined;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [open, setOpen] = useState(false);
  const path = shownPath(edit.path, cwd) ?? t("diff.noPath");
  return (
    <Collapsible
      data-kind="diff-file"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) store.track("diff_file_opened", { view: "session" });
      }}
    >
      <CollapsibleTrigger data-kind="diff-row">
        <ChevronRightIcon size={12} data-slot="diff-chevron" aria-hidden="true" />
        <span data-slot="diff-path" title={path}>
          <bdi>{path}</bdi>
        </span>
        {edit.created ? <span data-slot="diff-status">{t("diff.status.created")}</span> : null}
        <Counts additions={edit.additions} deletions={edit.deletions} />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {edit.lines !== undefined ? (
          <DiffView lines={edit.lines} />
        ) : (
          <p data-slot="tool-note">{t("tool.diff.tooLarge")}</p>
        )}
        <button
          type="button"
          data-slot="diff-link"
          onClick={() => {
            store.track("diff_edit_revealed", {});
            reveal.request(sessionKey, edit.toolId);
          }}
        >
          {t("overview.showInConversation")}
        </button>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function WorkspaceView({
  environmentId,
  sessionId,
  running,
}: {
  environmentId: string;
  sessionId: string;
  running: boolean;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [status, setStatus] = useState<Load<WorkspaceStatus>>({ state: "loading" });
  const [round, setRound] = useState(0);
  // Read again when a turn of this session ends: what it changed is in the folder now.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setRound((n) => n + 1);
    wasRunning.current = running;
  }, [running]);
  useEffect(() => {
    let current = true;
    // A new round reads over what is shown, so the list does not jump; a failure is replaced by the reading.
    setStatus((old) => (round > 0 && old.state === "ok" ? old : { state: "loading" }));
    store.workspaceStatus(environmentId, sessionId).then(
      (value) => {
        if (current) setStatus({ state: "ok", value });
      },
      (error: unknown) => {
        if (current) setStatus({ state: "error", reason: reasonOf(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [store, environmentId, sessionId, round]);
  const refresh = (
    <Tip label={t("files.refresh")} side="bottom">
      <Button data-variant="ghost" data-kind="files-action" onClick={() => setRound((n) => n + 1)}>
        <RefreshIcon />
      </Button>
    </Tip>
  );
  if (status.state === "loading")
    return <StateBlock tone="loading" size="inline" title={t("diff.workspace.loading")} />;
  if (status.state === "error")
    return (
      <StateBlock
        tone="error"
        size="inline"
        title={t("diff.workspace.failed")}
        reason={status.reason}
        action={{ label: t("files.retry"), onAction: () => setRound((n) => n + 1) }}
      />
    );
  const value = status.value;
  if (value.state === "not_git")
    return (
      <StateBlock
        tone="empty"
        size="inline"
        title={t("diff.workspace.notGit")}
        body={t("diff.workspace.notGitBody")}
      />
    );
  if (value.state === "untrusted")
    return (
      <StateBlock
        tone="empty"
        size="inline"
        title={t("diff.workspace.untrusted")}
        body={t("diff.workspace.untrustedBody", { folder: value.repository })}
      />
    );
  return (
    <>
      <div data-slot="files-head">
        <span data-slot="diff-scope">
          {value.head !== null
            ? t("diff.workspace.against", { commit: value.head.slice(0, 7) })
            : t("diff.workspace.noCommit")}
        </span>
        {refresh}
      </div>
      {value.files.length === 0 ? (
        <StateBlock tone="empty" size="inline" title={t("diff.workspace.clean")} />
      ) : (
        <ul data-slot="diff-files">
          {value.files.map((file) => (
            <li key={file.path}>
              <WorkspaceRow
                file={file}
                environmentId={environmentId}
                sessionId={sessionId}
                round={round}
              />
            </li>
          ))}
          {value.truncated ? (
            <li data-slot="files-quiet">
              {t("diff.workspace.truncated", { count: value.files.length })}
            </li>
          ) : null}
        </ul>
      )}
    </>
  );
}

const STATUS_KEY = {
  added: "diff.status.added",
  modified: "diff.status.modified",
  deleted: "diff.status.deleted",
  untracked: "diff.status.untracked",
} as const;

function WorkspaceRow({
  file,
  environmentId,
  sessionId,
  round,
}: {
  file: WorkspaceFile;
  environmentId: string;
  sessionId: string;
  round: number;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [open, setOpen] = useState(false);
  const [patch, setPatch] = useState<Load<WorkspacePatch> | undefined>(undefined);
  const load = useCallback(() => {
    setPatch({ state: "loading" });
    store.workspaceFile(environmentId, sessionId, file.path).then(
      (value) => setPatch({ state: "ok", value }),
      (error: unknown) => setPatch({ state: "error", reason: reasonOf(error) }),
    );
  }, [store, environmentId, sessionId, file.path]);
  // Read when first opened, and again in a new round while open; a closed one is read when it opens.
  const readIn = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!open || readIn.current === round) return;
    readIn.current = round;
    load();
  }, [open, round, load]);
  const lines = useMemo(() => (patch?.state === "ok" ? diffLines(patch.value.patch) : []), [patch]);
  return (
    <Collapsible
      data-kind="diff-file"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) store.track("diff_file_opened", { view: "workspace" });
      }}
    >
      <CollapsibleTrigger data-kind="diff-row">
        <ChevronRightIcon size={12} data-slot="diff-chevron" aria-hidden="true" />
        <span data-slot="diff-path" title={file.path}>
          <bdi>{file.path}</bdi>
        </span>
        <span data-slot="diff-status" data-status={file.status}>
          {t(STATUS_KEY[file.status])}
        </span>
        {file.binary === true ? (
          <span data-slot="diff-status">{t("diff.binary")}</span>
        ) : (
          <Counts additions={file.additions} deletions={file.deletions} />
        )}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {patch === undefined || patch.state === "loading" ? (
          <StateBlock tone="loading" size="inline" align="start" title={t("files.reading")} />
        ) : patch.state === "error" ? (
          <StateBlock
            tone="error"
            size="inline"
            align="start"
            title={t("diff.workspace.fileFailed")}
            reason={patch.reason}
            action={{ label: t("files.retry"), onAction: load }}
          />
        ) : patch.value.binary ? (
          <p data-slot="tool-note">{t("diff.binaryBody")}</p>
        ) : lines.length === 0 ? (
          <p data-slot="tool-note">{t("diff.noChange")}</p>
        ) : (
          <>
            <DiffView lines={lines} />
            {patch.value.truncated ? <p data-slot="tool-note">{t("diff.truncated")}</p> : null}
          </>
        )}
        {file.status !== "deleted" ? (
          <button type="button" data-slot="diff-link" onClick={() => store.showInFiles(file.path)}>
            {t("files.showInFiles")}
          </button>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}
