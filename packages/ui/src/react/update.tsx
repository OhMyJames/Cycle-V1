import { Button } from "@ui-sdk/react/button";
import { useState } from "react";
import type { UpdateState } from "../api.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { DownloadIcon, ErrorCircleIcon, WarningIcon } from "./icons.tsx";
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
export function UpdateFooter() {
  const store = useAppStore();
  const update = useAppState((s) => s.update);
  if (update === undefined) return null;
  // What the banner already says is not said twice.
  const inBanner =
    update.kind === "available" ||
    update.kind === "downloading" ||
    update.kind === "installing" ||
    (update.kind === "error" && update.version !== undefined);
  const line = inBanner ? "" : updateLine(update);
  const asking =
    update.kind === "checking" || update.kind === "downloading" || update.kind === "installing";
  return (
    <div data-slot="update-footer">
      <span data-slot="hint">Cycle {update.current}</span>
      {line !== "" ? (
        <span data-slot="hint" data-update={update.kind} role="status">
          {line}
        </span>
      ) : null}
      {update.kind !== "disabled" ? (
        <Button data-variant="ghost" disabled={asking} onClick={() => void store.checkForUpdate()}>
          Check for updates
        </Button>
      ) : null}
    </div>
  );
}
