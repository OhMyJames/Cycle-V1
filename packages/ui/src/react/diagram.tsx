import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from "react";
import { type DiagramScheme, type Drawn, drawDiagram } from "../diagram.ts";
import { useI18n } from "./i18n.tsx";
import { useOptionalAppStore } from "./store-context.tsx";

const DARK = "(prefers-color-scheme: dark)";
const subscribeScheme = (change: () => void) => {
  const query = matchMedia(DARK);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
const schemeNow = (): DiagramScheme => (matchMedia(DARK).matches ? "dark" : "light");

/**
 * A ```mermaid fence, drawn (diagram.ts) once the fence is closed. Until then, while it is drawn, and when it cannot be,
 * it is the code block it always was (`code`), so nothing flickers: the block is swapped for the picture once, when the
 * picture is ready. The block stays mounted under the picture, and "Show source" brings it back, with its Copy.
 * The picture opens large on a press.
 */
export function Diagram({
  source,
  complete,
  code,
}: {
  source: string;
  /** The fence is closed: the source is final. */
  complete: boolean;
  code: ReactNode;
}) {
  const { t } = useI18n();
  const store = useOptionalAppStore();
  const scheme = useSyncExternalStore(subscribeScheme, schemeNow, schemeNow);
  const [drawn, setDrawn] = useState<(Drawn & { key: string }) | undefined>(undefined);
  const [showSource, setShowSource] = useState(false);
  const [open, setOpen] = useState(false);
  const id = useId();
  const key = `${scheme}\n${source}`;

  useEffect(() => {
    if (!complete) return;
    let live = true;
    void drawDiagram(source, scheme).then((result) => {
      if (live) setDrawn({ ...result, key });
    });
    return () => {
      live = false;
    };
  }, [complete, source, scheme, key]);

  // A picture of another source or scheme stays up while this one is drawn; one of a source not yet complete does not.
  const picture = complete && drawn?.ok === true ? drawn : undefined;
  const failed = complete && drawn?.key === key && !drawn.ok;
  const alt = picture === undefined || picture.title === "" ? t("diagram.alt") : picture.title;

  const toggle = () => {
    if (!showSource) store?.track("diagram_source_shown", {});
    setShowSource(!showSource);
  };

  return (
    <>
      <div id={id} hidden={picture !== undefined && !showSource} data-slot="diagram-source">
        {code}
      </div>
      {picture !== undefined && !showSource ? (
        <figure data-slot="diagram">
          <button
            type="button"
            data-slot="diagram-open"
            aria-label={t("diagram.open")}
            onClick={() => {
              store?.track("diagram_opened", {});
              setOpen(true);
            }}
          >
            <img src={picture.src} alt={alt} width={picture.width} height={picture.height} />
          </button>
        </figure>
      ) : null}
      {picture !== undefined ? (
        <button
          type="button"
          data-slot="code-fold-toggle"
          aria-expanded={showSource}
          aria-controls={id}
          onClick={toggle}
        >
          {showSource ? t("diagram.showDiagram") : t("diagram.showSource")}
        </button>
      ) : null}
      {failed ? <p data-slot="diagram-note">{t("diagram.failed")}</p> : null}
      {picture !== undefined ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogBackdrop />
          <DialogContent data-palette="image" data-kind="diagram">
            <DialogTitle>{alt}</DialogTitle>
            <img src={picture.src} alt={alt} width={picture.width} height={picture.height} />
            <DialogClose>{t("image.close")}</DialogClose>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
