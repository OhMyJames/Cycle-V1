import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, CopyIcon } from "./icons.tsx";
import { useOptionalAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** How long the check and "Copied" stay after a press. */
const COPIED_MS = 1500;

/**
 * An icon that copies some text, through main (the page has no clipboard of its own). After a press it is a check for a
 * moment and its name says "Copied", or why it did not: said to a screen reader as well, without a toast. Without a store
 * (a preview drawn outside the app) there is nowhere to copy to, and it is not drawn.
 */
export function CopyButton({
  label,
  text,
  onCopied,
  slot,
}: {
  /** What a press does, like "Copy the reply": the button's name. */
  label: string;
  /** Read at the press, so a long text is not gathered on every render. */
  text: () => string;
  onCopied?: () => void;
  slot: string;
}) {
  const { t } = useI18n();
  const store = useOptionalAppStore();
  const [copied, setCopied] = useState<"done" | "failed" | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (store === undefined) return null;
  const said =
    copied === "done" ? t("tool.copied") : copied === "failed" ? t("tool.copyFailed") : undefined;
  const copy = () => {
    void store.copyText(text()).then((done) => {
      setCopied(done ? "done" : "failed");
      if (done) onCopied?.();
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(undefined), COPIED_MS);
    });
  };
  return (
    <>
      <Tip label={said ?? label}>
        <button type="button" data-slot={slot} data-copied={copied} onClick={copy}>
          {copied === "done" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
        </button>
      </Tip>
      <span data-slot="visually-hidden" role="status">
        {said ?? ""}
      </span>
    </>
  );
}
