// A new session before its first message (docs/protocol.md §6): where it runs and with which agent are chosen here, the
// first message is written in the box below, and sending it is what makes the session. Until then nothing of it is in
// the daemon, and so nothing of it is in the sidebar.
import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { type ReactNode, useMemo, useState } from "react";
import type { EnvironmentConfig } from "../api.ts";
import { applyUpdate, emptyConversation } from "../model/index.ts";
import { BLANK_KEY, type BlankConversation } from "../store/index.ts";
import { Composer } from "./composer.tsx";
import { ConfigForm, propertiesOf } from "./config-form.tsx";
import { ConversationView } from "./conversation.tsx";
import { FolderBrowser } from "./folder-browser.tsx";
import { useI18n } from "./i18n.tsx";
import { WarningIcon } from "./icons.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/**
 * What a new session starts with where nothing is set: the schema's `default` (docs/protocol.md §10). A session that
 * exists shows "Not set" for such a setting, since its agent's default may since have changed; one not yet made does not.
 */
type Settings = Record<string, string>;
const defaultsOf = (schema: Record<string, unknown>): Settings =>
  Object.fromEntries(
    propertiesOf(schema).flatMap(([key, property]) =>
      typeof property.default === "string" ? [[key, property.default]] : [],
    ),
  );

export function BlankConversationView({
  blank,
  environments,
  connected,
  follow,
  sidebarToggle,
  onSent,
}: {
  blank: BlankConversation;
  /** The environments a session can be started on: those that are connected. */
  environments: EnvironmentConfig[];
  /** The blank conversation's environment is connected. */
  connected: boolean;
  follow: number;
  sidebarToggle?: ReactNode;
  onSent: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const status = useAppState((s) => s.status[blank.environmentId]);
  // Read here so that the page draws again when they come: which agent starts depends on them.
  const agents = useAppState((s) => s.agents[blank.environmentId]);
  const available = useMemo(() => (agents ?? []).filter((a) => a.available), [agents]);
  const agent = store.blankAgent(blank);
  const environment = environments.find((h) => h.id === blank.environmentId);
  const [browsing, setBrowsing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [answering, setAnswering] = useState(false);
  const answer = async (trusted: boolean | undefined) => {
    setAnswering(true);
    try {
      await store.answerTrust(trusted);
    } finally {
      setAnswering(false);
    }
  };
  const starting = blank.starting !== undefined;
  // The first message, shown as it will be in the session while the session is being made.
  const shown = useMemo(
    () =>
      blank.starting === undefined
        ? undefined
        : applyUpdate(emptyConversation(), {
            sessionUpdate: "user_message",
            messageId: "starting",
            content: blank.starting,
          } as never),
    [blank.starting],
  );
  const local = environment?.kind === "local";
  const canBrowse = local || status?.capabilities?.folders === true;
  const browse = async () => {
    if (!local) return setBrowsing(true);
    const chosen = await store.chooseDirectory();
    if (chosen !== undefined) store.changeBlank({ cwd: chosen });
  };
  // Why it cannot be sent yet, said above the box (once: the box itself keeps its usual words). Empty while what it starts
  // with is still being read, which says nothing of its own.
  const blocked = starting
    ? t("blank.starting")
    : blank.cwd.trim() === ""
      ? t("blank.chooseFolder")
      : agent === undefined || blank.config === undefined
        ? ""
        : undefined;
  const placeholder = t("composer.placeholder.idle");

  // Before the first message the box sits in the middle with where it runs just above it (old-cycle's new session): what
  // is chosen and what is written are one thing. Once it is sent, the message shows as the conversation and the box goes
  // to the foot, where it is in a session.
  // Where it runs: above the box, and still there, off, while the session is being made from the first message.
  const where = (
    <fieldset data-slot="blank-where" disabled={starting} aria-label={t("blank.where")}>
      {environments.length > 1 ? (
        <Field name="environment">
          <FieldLabel>{t("newSession.environment")}</FieldLabel>
          <Select
            items={environments.map((h) => ({ value: h.id, label: h.name }))}
            value={blank.environmentId}
            onValueChange={(next) => {
              if (typeof next === "string") store.changeBlank({ environmentId: next });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {environments.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <Field name="cwd" data-kind="blank-folder">
        <FieldLabel>{t("blank.folder")}</FieldLabel>
        <div data-slot="row">
          <Input
            value={blank.cwd}
            placeholder={t("blank.folder.placeholder")}
            spellCheck={false}
            onChange={(e) => store.changeBlank({ cwd: e.currentTarget.value })}
          />
          {canBrowse ? (
            <Button data-variant="outline" disabled={starting} onClick={() => void browse()}>
              {t("newSession.browse")}
            </Button>
          ) : null}
        </div>
      </Field>
      {available.length > 1 ? (
        <Field name="agent">
          <FieldLabel>{t("blank.agent")}</FieldLabel>
          <Select
            items={available.map((a) => ({ value: a.id, label: a.name }))}
            value={agent?.id ?? null}
            onValueChange={(next) => {
              if (typeof next === "string") store.changeBlank({ agent: next });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {available.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
    </fieldset>
  );
  const box = (
    <Composer
      key={`composer:${BLANK_KEY}`}
      environmentId={blank.environmentId}
      sessionKey={BLANK_KEY}
      blank
      canAttach={agent?.promptCapabilities?.image != null}
      settings={
        agent !== undefined && blank.config !== undefined
          ? {
              schema: agent.configSchema,
              value: { ...defaultsOf(agent.configSchema), ...blank.config },
            }
          : undefined
      }
      onSetting={(key, value) => store.changeBlank({ setting: { key, value } })}
      onOpenSettings={() => setSettingsOpen(true)}
      enabled={!starting}
      connected={connected}
      activity="idle"
      blocked={blocked}
      placeholder={placeholder}
      onSent={onSent}
    />
  );
  return (
    <>
      <header data-slot="session-header">
        {sidebarToggle}
        <div data-slot="session-heading">
          <h1>{t("blank.title")}</h1>
        </div>
      </header>
      {/* One tree before and after the first message is sent, so the box and the choices keep their focus and state when a
          start fails and they come back: only the stage's layout changes (data-starting). */}
      <div data-slot="blank-stage" data-starting={shown !== undefined || undefined}>
        {shown !== undefined ? (
          <ConversationView
            sessionKey={BLANK_KEY}
            follow={follow}
            conversation={shown}
            loading={false}
            awaitingApproval={false}
          />
        ) : (
          <div data-slot="blank-lead">
            {connected &&
            agents !== undefined &&
            agent === undefined &&
            status?.state === "connected" ? (
              <div data-slot="empty-block" role="status">
                <WarningIcon size={20} data-tone="attention" />
                <p data-slot="empty-title">
                  {t("blank.noAgent", { environment: environment?.name ?? blank.environmentId })}
                </p>
                <p data-slot="hint">
                  {t("blank.noAgentHint", {
                    environment: environment?.name ?? blank.environmentId,
                  })}
                </p>
                <Button
                  data-variant="outline"
                  onClick={() => void store.reloadAgents(blank.environmentId)}
                >
                  {t("blank.retryAgents")}
                </Button>
              </div>
            ) : blank.unreadable === true ? (
              <div data-slot="empty-block" role="alert">
                <p>{t("blank.unreadable")}</p>
                <Button data-variant="outline" onClick={store.retryBlank}>
                  {t("blank.retry")}
                </Button>
              </div>
            ) : (
              <p>{t("blank.lead")}</p>
            )}
          </div>
        )}
        {where}
        {box}
      </div>
      {/* A folder nobody has decided on: asked when the first message goes, before anything of the folder's own runs. */}
      <Dialog
        open={blank.asking !== undefined}
        onOpenChange={(open) => {
          if (!open && !answering) void answer(undefined);
        }}
      >
        <DialogBackdrop />
        <DialogContent>
          <DialogTitle>{t("trust.title")}</DialogTitle>
          <DialogDescription>
            {t("trust.description", { environment: environment?.name ?? "" })}
          </DialogDescription>
          {blank.asking !== undefined ? (
            <code data-slot="decision-path">{blank.asking.path}</code>
          ) : null}
          {blank.asking?.failed !== undefined ? (
            <p data-slot="hint" role="alert">
              {t("trust.failed", { reason: blank.asking.failed })}
            </p>
          ) : null}
          <div data-slot="row" data-dialog-footer="">
            <Button
              data-variant="ghost"
              disabled={answering}
              onClick={() => void answer(undefined)}
            >
              {t("trust.back")}
            </Button>
            <Button data-variant="outline" disabled={answering} onClick={() => void answer(false)}>
              {t("trust.startUntrusted")}
            </Button>
            <Button data-variant="solid" disabled={answering} onClick={() => void answer(true)}>
              {t("trust.startTrusted")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={browsing} onOpenChange={setBrowsing}>
        <DialogBackdrop />
        <DialogContent>
          <DialogTitle>{t("folders.title")}</DialogTitle>
          {browsing ? (
            <FolderBrowser
              start={blank.cwd.startsWith("/") ? blank.cwd : undefined}
              list={(path, hidden) => store.listFolders(blank.environmentId, path, hidden)}
              onChoose={(path) => {
                store.changeBlank({ cwd: path });
                setBrowsing(false);
              }}
              onBack={() => setBrowsing(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      {settingsOpen && agent !== undefined && blank.config !== undefined ? (
        <Dialog open onOpenChange={(open) => !open && setSettingsOpen(false)}>
          <DialogBackdrop />
          <DialogContent>
            <DialogTitle>{t("blank.settings")}</DialogTitle>
            <DialogDescription>{t("blank.settings.lead")}</DialogDescription>
            <ConfigForm
              schema={agent.configSchema}
              value={blank.config}
              onChange={(config) => store.changeBlank({ config })}
            />
            <div data-slot="row" data-dialog-footer="">
              <DialogClose>{t("common.close")}</DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
