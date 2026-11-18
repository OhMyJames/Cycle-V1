// The input of the composer: a Lexical editor whose document is read and written as Markdown (composer-markdown.ts), so
// that what is typed shows as it will read, and what goes out is what was typed. Enter sends; the rest of the keys that
// the composer has a use for (the arrows that walk through what was sent, the menus) are asked first.

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  PASTE_COMMAND,
} from "lexical";
import { createElement, type RefObject, useEffect, useRef } from "react";
import {
  $setMarkdown,
  markdownOf,
  NODES,
  setMarkdown,
  TRANSFORMERS_FOR_COMPOSER,
} from "../composer-markdown.ts";

export type InputKey = "enter" | "up" | "down" | "tab" | "escape";

/** Where the caret is, for what a key means there. */
export type Caret = {
  /** The text of the block the caret is in, up to the caret. A menu's trigger is looked for in it. */
  before: string;
  /** In the first block of the document, and in the last: the arrows are the caret's elsewhere. */
  first: boolean;
  last: boolean;
  /** The caret is in the first block, at its start. */
  atStart: boolean;
};

export type InputHandle = {
  focus: () => void;
  caret: () => Caret;
  /** Replaces the last `length` characters before the caret (in its block) with `text`. */
  replaceBeforeCaret: (length: number, text: string) => void;
};

export type MarkdownInputProps = {
  /** The Markdown. The editor is made to hold it when it is not what the editor last said. */
  value: string;
  onChange: (markdown: string) => void;
  disabled: boolean;
  label: string;
  placeholder: string;
  /**
   * Asked first of the keys named in `InputKey`. True: the key was used, and nothing else happens. Enter is always used up
   * (it sends, or does nothing): a new line is Shift+Enter.
   */
  onKey: (key: InputKey, event: KeyboardEvent) => boolean;
  /** Pictures pasted into the input. Other files are not taken. */
  onPasteFiles: (files: File[]) => void;
  handle?: RefObject<InputHandle | null>;
  /** The document or the caret changed: the menus look again at what is before the caret. */
  onCaret?: () => void;
  /** A menu of choices is open below the input: the input says so, and which one is active, to those who cannot see it. */
  menu?: { id: string; open: boolean; activeId?: string | undefined };
};

const caretOf = (editor: LexicalEditor): Caret => {
  const none: Caret = { before: "", first: true, last: true, atStart: true };
  return editor.read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return none;
    const anchor = selection.anchor;
    const node = anchor.getNode();
    const block = node.getTopLevelElement();
    if (block === null) return none;
    // The block's text up to the caret: what comes before the anchor's node in the block, then the node up to the caret.
    let before = "";
    let found = false;
    const walk = (parent: { getChildren?: () => unknown[] } & object): void => {
      for (const child of (parent.getChildren?.() ?? []) as {
        getKey: () => string;
        getTextContent: () => string;
        getChildren?: () => unknown[];
      }[]) {
        if (found) return;
        if (child.getKey() === node.getKey()) {
          before += anchor.type === "text" ? child.getTextContent().slice(0, anchor.offset) : "";
          found = true;
          return;
        }
        if (child.getChildren !== undefined) {
          walk(child);
          if (found) return;
        } else {
          before += child.getTextContent();
        }
      }
    };
    if (block.getKey() === node.getKey()) found = true;
    else walk(block);
    const first = block.getPreviousSibling() === null;
    return {
      before,
      first,
      last: block.getNextSibling() === null,
      atStart: first && before === "",
    };
  });
};

function Behaviour({ props }: { props: MarkdownInputProps }) {
  const [editor] = useLexicalComposerContext();
  // What the props say now, for the handlers that are made once.
  const latest = useRef(props);
  latest.current = props;
  const emitted = useRef(props.value);

  useEffect(() => {
    editor.setEditable(!props.disabled);
  }, [editor, props.disabled]);

  // The editor tells of what the person did; what was put there from outside is not told back unless it was changed on the way.
  useEffect(
    () =>
      editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
        latest.current.onCaret?.();
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
        const markdown = markdownOf(editor);
        if (markdown === emitted.current) return;
        emitted.current = markdown;
        latest.current.onChange(markdown);
      }),
    [editor],
  );

  // A text that did not come from the editor (a message taken back, one recalled, the box emptied by a send).
  useEffect(() => {
    if (props.value === emitted.current) return;
    emitted.current = props.value;
    setMarkdown(editor, props.value);
    editor.update(() => $getRoot().selectEnd(), { discrete: true, tag: "history-merge" });
  }, [editor, props.value]);

  useEffect(() => {
    const key =
      (name: InputKey) =>
      (event: KeyboardEvent | null): boolean => {
        if (event === null) return false;
        if (name === "enter") {
          // Shift+Enter is a new line; Enter that confirms an IME composition is not a send.
          if (event.shiftKey || event.isComposing) return false;
          event.preventDefault();
          latest.current.onKey("enter", event);
          return true;
        }
        if (event.isComposing) return false;
        if (!latest.current.onKey(name, event)) return false;
        event.preventDefault();
        return true;
      };
    const stops = [
      editor.registerCommand(KEY_ENTER_COMMAND, key("enter"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, key("up"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, key("down"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_TAB_COMMAND, key("tab"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ESCAPE_COMMAND, key("escape"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const data = (event as ClipboardEvent).clipboardData;
          const pictures = Array.from(data?.files ?? []).filter((f) => f.type.startsWith("image/"));
          if (pictures.length > 0) {
            event.preventDefault();
            latest.current.onPasteFiles(pictures);
            return true;
          }
          // Text goes in as text, whatever it came from: pasted HTML would bring formatting nobody typed.
          const text = data?.getData("text/plain") ?? "";
          if (text === "") return false;
          event.preventDefault();
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) selection.insertRawText(text);
          });
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [editor]);

  useEffect(() => {
    const handle = latest.current.handle;
    if (handle === undefined) return;
    handle.current = {
      focus: () => editor.focus(),
      caret: () => caretOf(editor),
      replaceBeforeCaret: (length, text) =>
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const node = selection.anchor.getNode();
          // What was typed of a trigger is in the one text node the caret is in, so it is replaced there, without the
          // browser's own selection (which a test, and a caret that has just moved, may not have).
          if ($isTextNode(node) && selection.anchor.type === "text") {
            const end = selection.anchor.offset;
            node.spliceText(Math.max(0, end - length), Math.min(length, end), text, true);
          } else {
            selection.insertRawText(text);
          }
        }),
    };
    return () => {
      handle.current = null;
    };
  }, [editor]);

  return null;
}

export function MarkdownInput(props: MarkdownInputProps) {
  // The document it starts with. Later changes of the text arrive through the plugin, which tells them from the editor's own.
  const first = useRef(props.value);
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "composer",
        nodes: NODES,
        editable: !props.disabled,
        editorState: () => $setMarkdown(first.current),
        onError: (error) => {
          throw error;
        },
      }}
    >
      <RichTextPlugin
        contentEditable={
          <ContentEditable
            data-slot="composer-input"
            aria-label={props.label}
            aria-multiline
            aria-haspopup={props.menu === undefined ? undefined : "listbox"}
            aria-expanded={props.menu?.open}
            aria-controls={props.menu?.open ? props.menu.id : undefined}
            aria-activedescendant={props.menu?.open ? props.menu.activeId : undefined}
            aria-placeholder={props.placeholder}
            placeholder={createElement(
              "div",
              { "data-slot": "composer-placeholder" },
              props.placeholder,
            )}
          />
        }
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <ListPlugin />
      <MarkdownShortcutPlugin transformers={TRANSFORMERS_FOR_COMPOSER} />
      <Behaviour props={props} />
    </LexicalComposer>
  );
}
