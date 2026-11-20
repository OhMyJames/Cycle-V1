import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import { useState } from "react";
import type { SessionSummary, UpdateState } from "../api.ts";
import { CodeThemeItems } from "./code-theme-picker.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { DownloadIcon, ErrorCircleIcon, SettingsIcon, WarningIcon } from "./icons.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** Whole megabytes, and tenths while the whole is small (an update that changed a little). */
const megabytes = (bytes: number, total: number): string =>
  (bytes / 1e6).toFixed(total < 10e6 ? 1 : 0);

/** What the update is doing, in a few words, or nothing when there is nothing to say. */
export const updateLine = (update: UpdateState): string => {
  switch (update.kind) {
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return "Up to date";
    case "available":
      return `Version ${update.version} is available`;
    case "downloading":
      return `Downloading ${update.how === "difference" ? "the changes for " : ""}${update.version}: ${megabytes(update.received, update.total)} of ${megabytes(update.total, update.total)} MB`;
    case "installing":
      return `Installing ${update.version}…`;
    case "error":
      return update.message;
    case "disabled":
      return update.reason;
    case "idle":
      return "";
  }
};

/** At the top of the page when there is something to do about the update. */
export function UpdateBanner() {
  const store = useAppStore();
  const { t } = useI18n();
  const update = useAppState((s) => s.update);
  const [confirming, setConfirming] = useState(false);
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  if (update === undefined) return null;
  const busy = update.kind === "downloading" || update.kind === "installing";
  const failedInstall = update.kind === "error" && update.version !== undefined;
  if (update.kind !== "available" && !busy && !failedInstall) return null;
  const version =
    update.kind === "error" ? update.version : (update as { version: string }).version;
  if (update.kind === "available" && dismissed === version) return null;
  return (
    <div data-slot="banner" data-severity={failedInstall ? "error" : "info"} role="status">
      {failedInstall ? <ErrorCircleIcon /> : <DownloadIcon />}
      <span data-slot="update-line">
        {failedInstall
          ? `Updating to ${version} failed: ${updateLine(update)}`
          : updateLine(update)}
      </span>
      {update.kind === "available" ? (
        <Button data-variant="ghost" onClick={() => setDismissed(version)}>
          {t("update.dismiss")}
        </Button>
      ) : null}
      {!busy ? (
        <Button data-variant="outline" onClick={() => setConfirming(true)}>
          {failedInstall ? "Try again" : "Update and restart"}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Update to ${version}?`}
        description="Cycle closes and opens again as the new version. A session on This computer that is working is interrupted; sessions on other environments carry on."
        confirmLabel="Update and restart"
        onConfirm={() => store.installUpdate()}
      />
    </div>
  );
}

/**
 * The sessions an update would interrupt: a turn running or waiting on the person, or background tasks (the same
 * test `cycle stop` makes, docs/daemon.md "停止和升级").
 */
export const workingSessions = (
  sessions: readonly SessionSummary[] | undefined,
): SessionSummary[] =>
  (sessions ?? []).filter(
    (s) => s.state === "running" || s.state === "requires_action" || (s.background ?? 0) > 0,
  );

/**
 * An environment whose daemon is too old for this app: one line under the title, with a button that updates it over
 * ssh. When that cannot be done the line says why and the command is there to run by hand. When sessions there are
 * working, the confirmation names them first, and the person chooses to wait for them or to interrupt them.
 */
export function DaemonBanner({ environmentId }: { environmentId: string }) {
  const store = useAppStore();
  const { t } = useI18n();
  const daemon = useAppState((s) => s.status[environmentId]?.daemon);
  const name = useAppState((s) => s.environments.find((e) => e.id === environmentId)?.name);
  const incompatible = useAppState((s) => s.status[environmentId]?.incompatible);
  const sessions = useAppState((s) => s.sessions[environmentId]);
  const [confirming, setConfirming] = useState(false);
  const upgrade = daemon?.upgrade;
  if (incompatible !== undefined) {
    // The daemon speaks another protocol: nothing is connected, so there is no version to show, only why and what to do.
    const environment = name ?? environmentId;
    const said = {
      environment,
      supported: incompatible.supported.join(", "),
      requested: incompatible.requested,
    };
    return (
      <div data-slot="banner" data-kind="incompatible" data-severity="error" role="alert">
        <ErrorCircleIcon />
        <span data-slot="update-line">
          {t(
            incompatible.with === "daemon"
              ? "daemon.protocolOlder"
              : incompatible.with === "app"
                ? "daemon.protocolNewer"
                : "daemon.protocolOther",
            said,
          )}
        </span>
        {incompatible.command !== undefined ? (
          <code data-slot="command" title={t("daemon.byHand", { environment })}>
            {incompatible.command}
          </code>
        ) : null}
      </div>
    );
  }
  if (daemon === undefined || upgrade === undefined) return null;
  const failed = upgrade.error !== undefined;
  const waiting = upgrade.waiting === true && !failed;
  const environment = name ?? environmentId;
  const working = workingSessions(sessions);
  const named = working.map((s) => s.title || t("daemon.untitled")).join(", ");
  return (
    <div
      data-slot="banner"
      data-kind="daemon"
      data-severity={failed ? "error" : "warning"}
      role="status"
    >
      {failed ? <ErrorCircleIcon /> : <WarningIcon />}
      <span data-slot="update-line">
        {failed
          ? t("daemon.failed", { environment, error: upgrade.error ?? "" })
          : waiting
            ? t("daemon.waiting", { environment, to: upgrade.to })
            : t("daemon.tooOld", { environment, version: daemon.version })}
      </span>
      <Button
        data-variant="outline"
        disabled={upgrade.running === true}
        onClick={() => setConfirming(true)}
      >
        {upgrade.running === true
          ? t("daemon.updating")
          : failed
            ? t("daemon.tryAgain")
            : waiting
              ? t("daemon.updateNow")
              : t("daemon.update", { to: upgrade.to })}
      </Button>
      {failed ? (
        <code data-slot="command" title={t("daemon.byHand", { environment })}>
          {upgrade.command}
        </code>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("daemon.confirmTitle", { environment, to: upgrade.to })}
        description={
          working.length > 0
            ? t("daemon.confirmBusy", { sessions: named })
            : t("daemon.confirmBody", { environment })
        }
        {...(working.length > 0
          ? waiting
            ? {
                // Already waiting for them: what is left to choose is to stop waiting.
                confirmLabel: t("daemon.confirmNow"),
                destructive: true,
                onConfirm: () => store.upgradeDaemon(environmentId, "now"),
              }
            : {
                confirmLabel: t("daemon.confirmLater"),
                onConfirm: () => store.upgradeDaemon(environmentId, "later"),
                alternative: {
                  label: t("daemon.confirmNow"),
                  destructive: true,
                  onConfirm: () => store.upgradeDaemon(environmentId, "now"),
                },
              }
          : {
              confirmLabel: t("daemon.confirm"),
              // Nothing working any more while it waited: an update now interrupts nothing.
              onConfirm: () => store.upgradeDaemon(environmentId, waiting ? "now" : undefined),
            })}
      />
    </div>
  );
}

/**
 * The foot of the sidebar: which version this is, what the update is doing, and a menu of what belongs to the app (the
 * colours of code, a check for updates). One quiet row: these are used rarely and must not take room from the list.
 */
export function UpdateFooter() {
  const store = useAppStore();
  const { t } = useI18n();
  const update = useAppState((s) => s.update);
  const analytics = useAppState((s) => s.analytics);
  // What the banner already says is not said twice.
  const inBanner =
    update !== undefined &&
    (update.kind === "available" ||
      update.kind === "downloading" ||
      update.kind === "installing" ||
      (update.kind === "error" && update.version !== undefined));
  const line = update === undefined || inBanner ? "" : updateLine(update);
  const asking =
    update?.kind === "checking" || update?.kind === "downloading" || update?.kind === "installing";
  return (
    <div data-slot="update-footer">
      <div data-slot="update-text">
        {update !== undefined ? <span data-slot="hint">Cycle {update.current}</span> : null}
        {line !== "" ? (
          <span data-slot="hint" data-update={update?.kind} role="status" title={line}>
            {line}
          </span>
        ) : null}
      </div>
      <Menu
        onAction={(value) => {
          if (value === "check-for-updates") void store.checkForUpdate();
          else if (value === "toggle-analytics" && analytics !== undefined)
            void store.setAnalytics(!analytics.enabled);
        }}
      >
        <MenuTrigger aria-label={t("app.settings")} title={t("app.settings")} data-variant="ghost">
          <SettingsIcon />
        </MenuTrigger>
        <MenuContent side="top" align="end">
          <CodeThemeItems />
          {analytics?.available ? (
            <>
              <MenuSeparator />
              <MenuItem value="toggle-analytics">
                {t(analytics.enabled ? "app.analyticsOff" : "app.analyticsOn")}
              </MenuItem>
            </>
          ) : null}
          {update !== undefined && update.kind !== "disabled" ? (
            <>
              <MenuSeparator />
              <MenuItem value="check-for-updates" disabled={asking}>
                {t("app.checkForUpdates")}
              </MenuItem>
            </>
          ) : null}
        </MenuContent>
      </Menu>
    </div>
  );
}
