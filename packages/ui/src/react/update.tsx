import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import { useState } from "react";
import type { UpdateState } from "../api.ts";
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
  const update = useAppState((s) => s.update);
  const [confirming, setConfirming] = useState(false);
  if (update === undefined) return null;
  const busy = update.kind === "downloading" || update.kind === "installing";
  const failedInstall = update.kind === "error" && update.version !== undefined;
  if (update.kind !== "available" && !busy && !failedInstall) return null;
  const version =
    update.kind === "error" ? update.version : (update as { version: string }).version;
  return (
    <div data-slot="banner" data-severity={failedInstall ? "error" : "info"} role="status">
      {failedInstall ? <ErrorCircleIcon /> : <DownloadIcon />}
      <span data-slot="update-line">
        {failedInstall
          ? `Updating to ${version} failed: ${updateLine(update)}`
          : updateLine(update)}
      </span>
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

/** An environment whose daemon is older than this app: what to run on that machine. */
export function DaemonBanner({ environmentId }: { environmentId: string }) {
  const daemon = useAppState((s) => s.status[environmentId]?.daemon);
  if (daemon?.upgrade === undefined) return null;
  return (
    <div data-slot="banner" data-severity="warning" role="status">
      <WarningIcon />
      <div data-slot="stack">
        <span>
          Cycle on this environment is {daemon.version}, older than this app. To update it, run this
          on the machine it runs on (what its sessions are doing is interrupted when it restarts):
        </span>
        <code data-slot="command">{daemon.upgrade}</code>
      </div>
    </div>
  );
}

/** In the sidebar: the running version, what the update is doing, and a way to ask now. */
/**
 * The foot of the sidebar: which version this is, what the update is doing, and a menu of what belongs to the app (the
 * colours of code, a check for updates). One quiet row: these are used rarely and must not take room from the list.
 */
export function UpdateFooter() {
  const store = useAppStore();
  const { t } = useI18n();
  const update = useAppState((s) => s.update);
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
        }}
      >
        <MenuTrigger aria-label={t("app.settings")} title={t("app.settings")} data-variant="ghost">
          <SettingsIcon />
        </MenuTrigger>
        <MenuContent side="top" align="end">
          <CodeThemeItems />
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
