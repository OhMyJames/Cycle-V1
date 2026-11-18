import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { useState } from "react";
import { MAX_SHOWN_BASE64, viewOfImage } from "../attachments.ts";
import type { Block } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";

/**
 * An image block of a conversation: what the agent sent, or what was sent to it. It is drawn only if `viewOfImage`
 * allows it (a known type, base64, a size the page can hold), from a data URL: nothing is fetched, so the page's CSP stands.
 * Click opens it large. Otherwise a line says what it was.
 */
export function ImageBlockView({ block, from }: { block: Block; from: "agent" | "user" }) {
  const { t, number } = useI18n();
  const [open, setOpen] = useState(false);
  const view = viewOfImage(block);
  if (!view.ok) {
    const megabytes = Math.round(
      ((typeof block.data === "string" ? block.data.length : MAX_SHOWN_BASE64) * 0.75) / 1048576,
    );
    return (
      <span data-slot="block-note">
        {view.reason === "too-large"
          ? t("image.tooLarge", {
              size: number(megabytes, {
                style: "unit",
                unit: "megabyte",
                maximumFractionDigits: 0,
              }),
            })
          : t("image.unsupported", { type: view.type })}
      </span>
    );
  }
  const alt = t(from === "agent" ? "image.alt.agent" : "image.alt.user");
  const name = view.name !== "" ? view.name : alt;
  return (
    <>
      <button
        type="button"
        data-slot="image"
        aria-label={t("image.open", { name })}
        onClick={() => setOpen(true)}
      >
        <img src={view.src} alt={alt} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogBackdrop />
        <DialogContent data-palette="image">
          <DialogTitle>{name}</DialogTitle>
          <img src={view.src} alt={alt} />
          <DialogClose>{t("image.close")}</DialogClose>
        </DialogContent>
      </Dialog>
    </>
  );
}
