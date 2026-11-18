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
  type Attachment,
  type AttachmentProblem,
  base64Bytes,
  canAdd,
  IMAGE_TYPES,
  isImageType,
} from "../attachments.ts";
import type { DraftStore } from "../drafts.ts";
import { useI18n } from "./i18n.tsx";
import { AttachIcon, CloseIcon } from "./icons.tsx";

export type ComposerProps = {
  /** False when there is no session, or it is still being read. */
  enabled: boolean;
  /** A turn is going: the button stops it, and a new prompt waits. */
  working: boolean;
  /** The agent takes images in a prompt: the person may attach them. Without it the controls are not there. */
  canAttach?: boolean;
  /** What is written in the box, and the images attached, kept for each session (drafts.ts). */
  drafts: DraftStore;
  /** Names the session the box is for. The box is made again for another, so its own state does not carry over. */
  draftKey: string;
  /** False when the message could not be sent: what was written is put back, so that it is not lost. */
  onSend: (
    text: string,
    attachments: readonly Attachment[],
  ) => boolean | void | Promise<boolean | void>;
  onStop: () => void | Promise<void>;
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

export function Composer({
  enabled,
  working,
  canAttach = false,
  drafts,
  draftKey,
  onSend,
  onStop,
}: ComposerProps) {
  const { t, number } = useI18n();
  // The text and the images are the session's draft, kept outside the box: going to another session and back finds them.
  const draft = useSyncExternalStore(
    drafts.subscribe,
    () => drafts.get(draftKey),
    () => drafts.get(draftKey),
  );
  const { text, attachments } = draft;
  const [problem, setProblem] = useState<string | undefined>();
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const canSend = enabled && !working && (text.trim() !== "" || attachments.length > 0);

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
    // What the box is for when the reading starts: the draft of this session, not of whichever is open when it ends.
    const generation = drafts.generation(draftKey);
    let first: string | undefined;
    for (const file of files) {
      const next = { name: file.name, type: file.type, bytes: file.size };
      const refused = canAdd(drafts.get(draftKey).attachments, next);
      if (refused !== undefined) {
        first ??= say(refused);
        continue;
      }
      try {
        const data = await toBase64(file);
        // The message was sent while this was being read: the image is no longer for a message that is still being written.
        if (drafts.generation(draftKey) !== generation) return;
        const bytes = base64Bytes(data) ?? file.size;
        if (!isImageType(file.type)) continue;
        // Another add may have finished while this one was reading: the limits are held to the draft as it is now.
        const refusedNow = canAdd(drafts.get(draftKey).attachments, next);
        if (refusedNow !== undefined) {
          first ??= say(refusedNow);
          continue;
        }
        const added = { id: crypto.randomUUID(), name: file.name, type: file.type, data, bytes };
        drafts.update(draftKey, (d) => ({ ...d, attachments: [...d.attachments, added] }));
      } catch {
        first ??= t("composer.problem.unreadable", { name: file.name });
      }
    }
    setProblem(first);
  };

  const send = async () => {
    if (!canSend) return;
    const message = drafts.get(draftKey);
    drafts.sent(draftKey);
    setProblem(undefined);
    const sentOk = await onSend(message.text, message.attachments);
    if (sentOk === false) {
      // Put back what was written, in front of whatever has been written since.
      drafts.update(draftKey, (d) => ({
        text: d.text === "" ? message.text : `${message.text}\n${d.text}`,
        attachments: [...message.attachments, ...d.attachments],
      }));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line; Enter that confirms an IME composition is not a send.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = imagesOf(event.clipboardData.files);
    if (!canAttach || images.length === 0) return;
    // A pasted picture is attached; pasted text goes into the box as it always did.
    event.preventDefault();
    void attach(images);
  };

  // Dropping files: listeners on the element itself (a drag is not something a keyboard does, so it is not a handler of the markup).
  const root = useRef<HTMLDivElement>(null);
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
                  drafts.update(draftKey, (d) => ({
                    ...d,
                    attachments: d.attachments.filter((x) => x.id !== a.id),
                  }))
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
          aria-label="Message"
          placeholder={
            enabled
              ? working
                ? "The agent is working…"
                : "Message the agent"
              : "Choose or start a session"
          }
          disabled={!enabled}
          value={text}
          onChange={(event) => {
            const value = event.currentTarget.value;
            drafts.update(draftKey, (d) => ({ ...d, text: value }));
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {working ? (
          <Button data-variant="outline" onClick={() => onStop()}>
            Stop
          </Button>
        ) : (
          <Button data-variant="solid" disabled={!canSend} onClick={send}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
