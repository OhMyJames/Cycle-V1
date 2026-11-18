import { Button } from "@ui-sdk/react/button";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { FileSearch } from "../api.ts";
import {
  ATTACHMENT_LIMITS,
  type AttachmentProblem,
  base64Bytes,
  canAdd,
  IMAGE_TYPES,
  isImageType,
} from "../attachments.ts";
import {
  fileUri,
  type Mention,
  mentionText,
  NOT_RECALLING,
  type Recall,
  recall,
  sentTexts,
} from "../draft.ts";
import { mentionQuery, mentionRow } from "../mention.ts";
import { type QueuedPrompt, textOf } from "../model/index.ts";
import { commandText, filterCommands, slashQuery } from "../slash.ts";
import { useI18n } from "./i18n.tsx";
import { AttachIcon, CloseIcon } from "./icons.tsx";
import { type InputHandle, type InputKey, MarkdownInput } from "./markdown-input.tsx";
import { optionId, PickerMenu, type PickerRow } from "./picker-menu.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

export type ComposerProps = {
  /** The host it is on, for what its daemon can do. */
  hostId: string;
  /** The session this box is for, as `viewKey` names it. A box is made anew for each session. */
  sessionKey: string;
  /** False when there is no session, or it is still being read. */
  enabled: boolean;
  /** The agent takes images in a prompt: the person may attach them. Without it the controls are not there. */
  canAttach?: boolean;
};

/** How long after the last key the files are asked for. */
const MENTION_DELAY = 120;

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

export function Composer({ hostId, sessionKey, enabled, canAttach = false }: ComposerProps) {
  const { t, number } = useI18n();
  const store = useAppStore();
  const draft = useSyncExternalStore(store.drafts.subscribe, () => store.drafts.get(sessionKey));
  const conversation = useAppState((s) => s.views[sessionKey]?.conversation);
  const working = (conversation?.status ?? "idle") !== "idle";
  const queue = conversation?.queue ?? [];
  const { text, attachments } = draft;
  // A daemon that has not said it queues is asked nothing it would refuse: a message waits for the turn to end.
  const capabilities = useAppState((s) => s.status[hostId]?.capabilities);
  const canQueue = capabilities?.queue === true;
  const canFind = capabilities?.files === true;
  // Counts the sends: an image still being read when the message goes out belongs to that message, not to the next one.
  const sent = useRef(0);
  const recalled = useRef<Recall>(NOT_RECALLING);
  const [problem, setProblem] = useState<string | undefined>();
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<InputHandle | null>(null);
  // What is being named after a slash or an @, and which of the matches is under the arrows. Escape closes the menu until
  // what was typed changes.
  const menuId = useId();
  const [typed, setTyped] = useState<{ slash?: string | undefined; mention?: string | undefined }>(
    {},
  );
  const [dismissed, setDismissed] = useState<string | undefined>();
  const [pointed, setPointed] = useState<{ query: string | undefined; index: number }>({
    query: undefined,
    index: 0,
  });
  const [found, setFound] = useState<{ query: string; result: FileSearch } | undefined>();
  // Files are asked for a moment after the last key, and only what answers the query as it stands now is shown.
  useEffect(() => {
    const query = typed.mention;
    if (query === undefined || !canFind) {
      setFound(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void store.searchFiles(query).then((result) => {
        if (current && result !== undefined) setFound({ query, result });
      });
    }, MENTION_DELAY);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [typed.mention, canFind, store]);
  const commandRows: PickerRow[] =
    typed.slash === undefined
      ? []
      : filterCommands(conversation?.commands ?? [], typed.slash).map((command) => ({
          key: command.name,
          name: `/${command.name}`,
          ...(command.hint !== undefined ? { hint: command.hint } : {}),
          description: command.description,
        }));
  const hits =
    typed.mention !== undefined && found?.query === typed.mention ? found.result.entries : [];
  const mentionRows: PickerRow[] = hits.map((hit) => {
    const row = mentionRow(hit.path, hit.kind);
    return { key: hit.path, name: row.name, description: row.folder };
  });
  const commandQuery = typed.slash === undefined ? undefined : `/${typed.slash}`;
  const mentionQueryText = typed.mention === undefined ? undefined : `@${typed.mention}`;
  const kind: "command" | "mention" | undefined =
    commandRows.length > 0 && commandQuery !== dismissed
      ? "command"
      : mentionRows.length > 0 && mentionQueryText !== dismissed
        ? "mention"
        : undefined;
  const rows = kind === "command" ? commandRows : kind === "mention" ? mentionRows : [];
  const query = kind === "command" ? commandQuery : mentionQueryText;
  const menuOpen = kind !== undefined;
  // A new query starts at the first match.
  const chosen = pointed.query === query ? pointed.index : 0;
  const active = Math.min(chosen, Math.max(rows.length - 1, 0));
  // Something was named that is not there: it is said, once, instead of showing nothing.
  const nothingFound =
    kind === undefined &&
    typed.mention !== undefined &&
    typed.mention !== "" &&
    found?.query === typed.mention &&
    hits.length === 0 &&
    mentionQueryText !== dismissed;
  const lookAtCaret = () => {
    const caret = input.current?.caret();
    setTyped({
      slash: caret === undefined ? undefined : slashQuery(caret.before, caret.first),
      mention: caret === undefined ? undefined : mentionQuery(caret.before),
    });
  };
  const pick = (index: number) => {
    if (kind === "command") {
      const command = (conversation?.commands ?? []).find(
        (c) => c.name === commandRows[index]?.key,
      );
      if (command === undefined) return;
      // What was typed of it, the slash and the query, is replaced by the whole name and a space.
      input.current?.replaceBeforeCaret((typed.slash?.length ?? 0) + 1, commandText(command));
    } else if (kind === "mention") {
      const hit = hits[index];
      const root = found?.result.root;
      if (hit === undefined || root === undefined) return;
      const mention: Mention = {
        path: hit.path,
        kind: hit.kind,
        uri: fileUri(root, hit.path, hit.kind),
        name: mentionRow(hit.path, hit.kind).name.replace(/\/$/, ""),
      };
      // The @ and what was typed after it become the path and a space; the link for the agent is kept beside the text.
      input.current?.replaceBeforeCaret(
        (typed.mention?.length ?? 0) + 1,
        `${mentionText(mention)} `,
      );
      store.drafts.addMention(sessionKey, mention);
    }
    input.current?.focus();
  };
  // While the agent works, a message is queued: it goes when the turn ends well (docs/protocol.md §8).
  const canSend =
    enabled && (!working || canQueue) && (text.trim() !== "" || attachments.length > 0);

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
      input.current?.focus();
    }
  };

  /** The keys the box asks about first. Enter sends (a new line is Shift+Enter); the arrows walk through what was sent. */
  const onKey = (key: InputKey, event: KeyboardEvent): boolean => {
    // An open menu has the keys first: the arrows choose, Enter and Tab take, Escape closes.
    if (menuOpen) {
      if (key === "up" || key === "down") {
        setPointed({ query, index: (active + (key === "up" ? rows.length - 1 : 1)) % rows.length });
        return true;
      }
      if (key === "enter" || key === "tab") {
        pick(active);
        return true;
      }
      if (key === "escape") {
        setDismissed(query);
        return true;
      }
    }
    if (key === "enter") {
      void send();
      return true;
    }
    if (key !== "up" && key !== "down") return false;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
    // They are the caret's unless it has nowhere to go: the first block going up, the last going down.
    const caret = input.current?.caret();
    if (caret === undefined || (key === "up" ? !caret.first : !caret.last)) return false;
    const found = recall(sentTexts(conversation?.items ?? []), recalled.current, text, key);
    if (found === undefined) return false;
    recalled.current = found.state;
    store.drafts.setText(sessionKey, found.text);
    return true;
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
        <div data-slot="composer-field">
          {menuOpen ? (
            <PickerMenu
              id={menuId}
              label={
                kind === "command" ? t("composer.commands.label") : t("composer.mentions.label")
              }
              rows={rows}
              active={active}
              onPick={pick}
              onHover={(index) => setPointed({ query, index })}
            />
          ) : nothingFound ? (
            <div data-slot="picker" role="status">
              {t("composer.mentions.empty")}
            </div>
          ) : null}
          <MarkdownInput
            value={text}
            onChange={(markdown) => {
              if (markdown !== recalled.current.shown) recalled.current = NOT_RECALLING;
              store.drafts.setText(sessionKey, markdown);
            }}
            disabled={!enabled}
            label={t("composer.message")}
            placeholder={
              enabled
                ? working
                  ? canQueue
                    ? t("composer.placeholder.working")
                    : t("composer.placeholder.busy")
                  : t("composer.placeholder.idle")
                : t("composer.placeholder.none")
            }
            onKey={onKey}
            onPasteFiles={(files) => void attach(files)}
            handle={input}
            onCaret={lookAtCaret}
            menu={{
              id: menuId,
              open: menuOpen,
              activeId: menuOpen ? optionId(menuId, active) : undefined,
            }}
          />
        </div>
        {working ? (
          <Button data-variant="outline" onClick={() => void store.cancel()}>
            {t("composer.stop")}
          </Button>
        ) : null}
        <Button data-variant="solid" disabled={!canSend} onClick={send}>
          {working && canQueue ? t("composer.queue") : t("composer.send")}
        </Button>
      </div>
    </div>
  );
}
