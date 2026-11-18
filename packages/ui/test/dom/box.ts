import { expect } from "bun:test";
import { act, waitFor } from "@testing-library/react";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from "lexical";
import { markdownOf } from "../../src/composer-markdown.ts";

// The message box is a Lexical editor. happy-dom has no real selection or input events for it, so the tests act on the
// editor the way its own commands do (a key is a command; text is inserted at the end); real typing is the Electron smoke test's.
export const editorOf = (box: HTMLElement): LexicalEditor => {
  const editor = (box as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (editor === undefined) throw new Error("the message box has no editor");
  return editor;
};
export const write = (box: HTMLElement, words: string) =>
  act(() => {
    editorOf(box).update(
      () => {
        $getRoot().selectEnd();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertRawText(words);
      },
      { discrete: true },
    );
  });
export const boxText = (box: HTMLElement): string => markdownOf(editorOf(box));
const KEYS = {
  Enter: KEY_ENTER_COMMAND,
  ArrowUp: KEY_ARROW_UP_COMMAND,
  ArrowDown: KEY_ARROW_DOWN_COMMAND,
} as const;
export const press = (box: HTMLElement, key: keyof typeof KEYS, init: KeyboardEventInit = {}) =>
  act(() => {
    editorOf(box).dispatchCommand(KEYS[key], new KeyboardEvent("keydown", { key, ...init }));
  });
export const ready = (box: HTMLElement) =>
  waitFor(() => expect(box.getAttribute("contenteditable")).toBe("true"));
