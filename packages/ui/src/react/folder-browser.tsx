// Choosing a folder on the machine of an environment that is not this computer: its daemon lists the folders, one level
// at a time (docs/protocol.md §8). For this computer the system's own chooser is used.
import { Button } from "@ui-sdk/react/button";
import { Listbox, ListboxItem } from "@ui-sdk/react/listbox";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FolderListing, ListFolders } from "../api.ts";
import { useI18n } from "./i18n.tsx";

export type FolderBrowserProps = {
  /** Where it starts: a folder, absolute; without it (or when it cannot be read) the environment's home. */
  start?: string | undefined;
  list: ListFolders;
  onChoose: (path: string) => void;
  onBack: () => void;
};

type Shown =
  | { kind: "loading" }
  | { kind: "error"; reason: string; path: string | undefined }
  | { kind: "listing"; listing: FolderListing };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function FolderBrowser({ start, list, onChoose, onBack }: FolderBrowserProps) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState(false);
  const [shown, setShown] = useState<Shown>({ kind: "loading" });
  // The answer to an older question is not shown: the person went on before it came.
  const asked = useRef(0);
  const go = useCallback(
    async (path: string | undefined, withHidden: boolean, fallbackToHome = false) => {
      asked.current += 1;
      const mine = asked.current;
      setShown({ kind: "loading" });
      try {
        const listing = await list(path, withHidden);
        if (mine === asked.current) setShown({ kind: "listing", listing });
      } catch (error) {
        if (mine !== asked.current) return;
        // The folder it started in is gone or cannot be read: it starts from home instead of from an error.
        if (fallbackToHome && path !== undefined) return void go(undefined, withHidden);
        setShown({ kind: "error", reason: messageOf(error), path });
      }
    },
    [list],
  );
  useEffect(() => {
    void go(start, false, true);
  }, [go, start]);
  const listing = shown.kind === "listing" ? shown.listing : undefined;
  const failedAt = shown.kind === "error" ? shown.path : undefined;
  const pathText = listing?.path ?? failedAt ?? "";
  return (
    <div data-slot="folder-browser">
      <div data-slot="stack">
        <p data-slot="row">
          <span data-slot="visually-hidden">{t("folders.path")}: </span>
          <code data-slot="path">{pathText}</code>
        </p>
        <div data-slot="row">
          <Button
            data-variant="outline"
            disabled={listing === undefined || listing.parent === null}
            onClick={() => listing?.parent != null && void go(listing.parent, hidden)}
          >
            {t("folders.up")}
          </Button>
          <Button
            data-variant="outline"
            disabled={listing === undefined}
            onClick={() => listing !== undefined && void go(listing.home, hidden)}
          >
            {t("folders.home")}
          </Button>
          <Button
            data-variant="ghost"
            aria-pressed={hidden}
            onClick={() => {
              const next = !hidden;
              setHidden(next);
              void go(listing?.path, next);
            }}
          >
            {t("folders.hidden")}
          </Button>
        </div>
        {shown.kind === "loading" ? <p data-slot="hint">{t("folders.loading")}</p> : null}
        {shown.kind === "error" ? (
          <div data-slot="stack" role="alert">
            <p>{t("folders.error", { reason: shown.reason })}</p>
            <Button data-variant="outline" onClick={() => void go(shown.path, hidden)}>
              {t("folders.retry")}
            </Button>
          </div>
        ) : null}
        {listing !== undefined && listing.folders.length === 0 ? (
          <p data-slot="hint">{t("folders.empty")}</p>
        ) : null}
        {listing !== undefined && listing.folders.length > 0 ? (
          <Listbox
            aria-label={t("folders.list")}
            value={null}
            onValueChange={(name) => {
              if (typeof name === "string")
                void go(`${listing.path === "/" ? "" : listing.path}/${name}`, hidden);
            }}
          >
            {listing.folders.map((folder) => (
              <ListboxItem key={folder.name} value={folder.name}>
                {folder.name}
              </ListboxItem>
            ))}
          </Listbox>
        ) : null}
        {listing?.truncated === true ? (
          <p data-slot="hint">{t("folders.truncated", { count: listing.folders.length })}</p>
        ) : null}
      </div>
      <div data-slot="row">
        <Button data-variant="outline" onClick={onBack}>
          {t("folders.cancel")}
        </Button>
        <Button
          data-variant="solid"
          disabled={listing === undefined}
          onClick={() => listing !== undefined && onChoose(listing.path)}
        >
          {t("folders.choose")}
        </Button>
      </div>
    </div>
  );
}
