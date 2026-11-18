import { Button } from "@ui-sdk/react/button";
import { Textarea } from "@ui-sdk/react/textarea";
import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  ATTACHMENT_LIMITS,
  type Attachment,
  type AttachmentProblem,
  base64Bytes,
  canAdd,
  IMAGE_TYPES,
  isImageType,
} from "../attachments.ts";
import { useI18n } from "./i18n.tsx";
import { AttachIcon, CloseIcon } from "./icons.tsx";

export type ComposerProps = {
  /** False when there is no session, or it is still being read. */
  enabled: boolean;
  /** A turn is going: the button stops it, and a new prompt waits. */
  working: boolean;
  /** The agent takes images in a prompt: the person may attach them. Without it the controls are not there. */
  canAttach?: boolean;
  onSend: (text: string, attachments: Attachment[]) => void | Promise<void>;
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

export function Composer({ enabled, working, canAttach = false, onSend, onStop }: ComposerProps) {
  const { t, number } = useI18n();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
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
    let have = attachments;
    let first: string | undefined;
    for (const file of files) {
      const next = { name: file.name, type: file.type, bytes: file.size };
      const refused = canAdd(have, next);
      if (refused !== undefined) {
        first ??= say(refused);
        continue;
      }
      try {
        const data = await toBase64(file);
        const bytes = base64Bytes(data) ?? file.size;
        if (!isImageType(file.type)) continue;
        have = [
          ...have,
          { id: crypto.randomUUID(), name: file.name, type: file.type, data, bytes },
        ];
      } catch {
        first ??= t("composer.problem.unreadable", { name: file.name });
      }
    }
    setAttachments(have);
    setProblem(first);
  };

  const send = async () => {
    if (!canSend) return;
    const sent = { text, attachments };
    setText("");
    setAttachments([]);
    setProblem(undefined);
    await onSend(sent.text, sent.attachments);
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
                onClick={() => setAttachments((all) => all.filter((x) => x.id !== a.id))}
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
          onChange={(event) => setText(event.currentTarget.value)}
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
