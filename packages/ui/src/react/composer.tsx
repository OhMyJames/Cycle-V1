import { Button } from "@ui-sdk/react/button";
import { Textarea } from "@ui-sdk/react/textarea";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ATTACHMENT_LIMITS,
  type AttachmentProblem,
  base64Bytes,
  canAdd,
  IMAGE_TYPES,
  isImageType,
} from "../attachments.ts";
import { NOT_RECALLING, type Recall, recall, sentTexts } from "../draft.ts";
import { type QueuedPrompt, textOf } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { AttachIcon, CloseIcon } from "./icons.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

export type ComposerProps = {
  /** The session this box is for, as `viewKey` names it. A box is made anew for each session. */
  sessionKey: string;
  /** False when there is no session, or it is still being read. */
  enabled: boolean;
  /** The agent takes images in a prompt: the person may attach them. Without it the controls are not there. */
  canAttach?: boolean;
};

/** A file as ACP carries an image: base64. Read in pieces, so that a large one does not overflow the call. */
const toBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

const imagesOf = (files: FileList | File[] | null | undefined): File[] =>
  Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));

/** What a queued message is called in the list: its words on one line, or what else it holds. */
const previewOf = (prompt: QueuedPrompt): { text: string; images: number } => ({
  text: textOf(prompt.prompt).replace(/\s+/g, " ").trim(),
  images: prompt.prompt.filter((b) => b.type === "image").length,
});

export function Composer({ sessionKey, enabled, canAttach = false }: ComposerProps) {
  const { t, number } = useI18n();
  const store = useAppStore();
  const draft = useSyncExternalStore(store.drafts.subscribe, () => store.drafts.get(sessionKey));
  const conversation = useAppState((s) => s.views[sessionKey]?.conversation);
  const working = (conversation?.status ?? "idle") !== "idle";
  const queue = conversation?.queue ?? [];
  const { text, attachments } = draft;
  // Counts the sends: an image still being read when the message goes out belongs to that message, not to the next one.
  const sent = useRef(0);
  const recalled = useRef<Recall>(NOT_RECALLING);
  const [problem, setProblem] = useState<string | undefined>();
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // While the agent works, a message is queued: it goes when the turn ends well (docs/protocol.md §8).
  const canSend = enabled && (text.trim() !== "" || attachments.length > 0);

  const megabytes = (bytes: number) =>
    number(bytes / 1048576, { style: "unit", unit: "megabyte", maximumFractionDigits: 0 });
  const say = (p: AttachmentProblem): string => {
    switch (p.reason) {
      case "type":
        return t("composer.problem.type", { name: p.name });
      case "block-too-large":
        return t("composer.problem.blockTooLarge", {
          name: p.name,
          limit: megabytes(ATTACHMENT_LIMITS.blockBytes),
        });
      case "prompt-too-large":
        return t("composer.problem.promptTooLarge", {
          limit: megabytes(ATTACHMENT_LIMITS.promptBytes),
        });
      case "too-many":
        return t("composer.problem.tooMany", { count: ATTACHMENT_LIMITS.blocks - 1 });
    }
  };

  /** Adds what can be added, one by one, by the limits of a prompt; says why for the first that cannot. */
  const attach = async (files: File[]) => {
    if (!canAttach || files.length === 0) return;
    const generation = sent.current;
    // The list as it is now, for the code that waits (reading a file) between looking and adding: two images pasted in
    // a row must both stay, and a list captured when the first began would lose the first.
    const now = () => store.drafts.get(sessionKey).attachments;
    let first: string | undefined;
    for (const file of files) {
      const next = { name: file.name, type: file.type, bytes: file.size };
      const refused = canAdd(now(), next);
      if (refused !== undefined) {
        first ??= say(refused);
        continue;
      }
      try {
        const data = await toBase64(file);
        // The message was sent while this was being read: the image is no longer for a message that is still being written.
        if (sent.current !== generation) return;
        const bytes = base64Bytes(data) ?? file.size;
        if (!isImageType(file.type)) continue;
        // Another add may have finished while this one was reading: the limits are held to the list as it is now.
        const refusedNow = canAdd(now(), next);
        if (refusedNow !== undefined) {
          first ??= say(refusedNow);
          continue;
        }
        store.drafts.setAttachments(sessionKey, [
          ...now(),
          { id: crypto.randomUUID(), name: file.name, type: file.type, data, bytes },
        ]);
      } catch {
        first ??= t("composer.problem.unreadable", { name: file.name });
      }
    }
    setProblem(first);
  };

  const send = async () => {
    if (!canSend) return;
    sent.current += 1;
    recalled.current = NOT_RECALLING;
    setProblem(undefined);
    await store.send();
  };

  const edit = async (queueId: string) => {
    if ((await store.dequeue(queueId)) !== undefined) {
      root.current?.querySelector("textarea")?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line; Enter that confirms an IME composition is not a send.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
      return;
    }
    if (
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    // Up and down walk through what was sent when the caret has nowhere to go: the first line going up, the last going down.
    const box = event.currentTarget;
    const before = box.value.slice(0, box.selectionStart);
    const after = box.value.slice(box.selectionEnd);
    const up = event.key === "ArrowUp";
    if (up ? before.includes("\n") : after.includes("\n")) return;
    const found = recall(
      sentTexts(conversation?.items ?? []),
      recalled.current,
      box.value,
      up ? "up" : "down",
    );
    if (found === undefined) return;
    event.preventDefault();
    recalled.current = found.state;
    store.drafts.setText(sessionKey, found.text);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = imagesOf(event.clipboardData.files);
    if (!canAttach || images.length === 0) return;
    // A pasted picture is attached; pasted text goes into the box as it always did.
    event.preventDefault();
    void attach(images);
  };

  // Dropping files: listeners on the element itself (a drag is not something a keyboard does, so it is not a handler of the markup).
  const attachRef = useRef(attach);
  attachRef.current = attach;
  useEffect(() => {
    const el = root.current;
    if (el === null || !canAttach) return;
    const hasFiles = (event: globalThis.DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const over = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDropping(true);
    };
    const leave = () => setDropping(false);
    const drop = (event: globalThis.DragEvent) => {
      setDropping(false);
      if (!hasFiles(event)) return;
      event.preventDefault();
      void attachRef.current(imagesOf(event.dataTransfer?.files));
    };
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("dragover", over);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", drop);
    };
  }, [canAttach]);

  return (
    <div data-slot="composer" data-dropping={dropping || undefined} ref={root}>
      {dropping ? <div data-slot="drop-hint">{t("composer.drop")}</div> : null}
      {queue.length > 0 ? (
        <ul data-slot="queued" aria-label={t("composer.queued.label")}>
          {queue.map((entry) => {
            const preview = previewOf(entry);
            const label =
              preview.text !== ""
                ? preview.text
                : t("composer.queued.images", { count: preview.images });
            return (
              <li key={entry.queueId} data-slot="queued-message">
                <span data-slot="queued-tag">{t("composer.queued.tag")}</span>
                <span data-slot="queued-text" title={label}>
                  {label}
                </span>
                <Button
                  data-variant="ghost"
                  aria-label={t("composer.queued.edit", { preview: label })}
                  onClick={() => void edit(entry.queueId)}
                >
                  {t("composer.queued.editShort")}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {attachments.length > 0 ? (
        <ul data-slot="attachments" aria-label={t("composer.attached")}>
          {attachments.map((a) => (
            <li key={a.id} data-slot="attachment">
              <img src={`data:${a.type};base64,${a.data}`} alt="" />
              <span data-slot="attachment-name">{a.name}</span>
              <button
                type="button"
                aria-label={t("composer.remove", { name: a.name })}
                onClick={() =>
                  store.drafts.setAttachments(
                    sessionKey,
                    store.drafts.get(sessionKey).attachments.filter((x) => x.id !== a.id),
                  )
                }
              >
                <CloseIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {problem !== undefined ? (
        <div data-slot="notice" data-severity="error" role="alert">
          {problem}
        </div>
      ) : null}
      <div data-slot="composer-row">
        {canAttach ? (
          <>
            <Button
              data-variant="ghost"
              aria-label={t("composer.attach")}
              title={t("composer.attach")}
              disabled={!enabled}
              onClick={() => picker.current?.click()}
            >
              <AttachIcon />
            </Button>
            <input
              ref={picker}
              type="file"
              hidden
              multiple
              accept={IMAGE_TYPES.join(",")}
              onChange={(event) => {
                void attach(imagesOf(event.currentTarget.files));
                event.currentTarget.value = "";
              }}
            />
          </>
        ) : null}
        <Textarea
          autoResize
          aria-label={t("composer.message")}
          placeholder={
            enabled
              ? working
                ? t("composer.placeholder.working")
                : t("composer.placeholder.idle")
              : t("composer.placeholder.none")
          }
          disabled={!enabled}
          value={text}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (next !== recalled.current.shown) recalled.current = NOT_RECALLING;
            store.drafts.setText(sessionKey, next);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {working ? (
          <Button data-variant="outline" onClick={() => void store.cancel()}>
            {t("composer.stop")}
          </Button>
        ) : null}
        <Button data-variant="solid" disabled={!canSend} onClick={send}>
          {working ? t("composer.queue") : t("composer.send")}
        </Button>
      </div>
    </div>
  );
}
