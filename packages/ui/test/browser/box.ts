import { waitFor } from "@testing-library/react";
import type { LexicalEditor } from "lexical";
import { expect } from "vitest";
import { userEvent } from "vitest/browser";
import { markdownOf } from "../../src/composer-markdown.ts";

// The message box is a Lexical editor, and the browser is a real one: the tests type into it and press its keys as a
// person does (the caret is put at the end first), through the browser's own input, not the editor's commands.
export const editorOf = (box: HTMLElement): LexicalEditor => {
  const editor = (box as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (editor === undefined) throw new Error("the message box has no editor");
  return editor;
};
/** userEvent.keyboard reads { and [ as the start of a key's name; doubled, they are the characters. */
const literal = (words: string) => words.replace(/[{[]/g, (c) => c + c);
/** The end of the whole text: ⌘↓ on a Mac (⌘End only scrolls there), Ctrl+End elsewhere. */
const END = /Mac/.test(navigator.userAgent)
  ? "{Meta>}{ArrowDown}{/Meta}"
  : "{Control>}{End}{/Control}";
/** Into the box, with the caret at the end: where a person who clicks in and goes on writing would be. */
const toEnd = async (box: HTMLElement) => {
  if (document.activeElement !== box) await userEvent.click(box);
  await userEvent.keyboard(END);
};
/** A wait of a fixed length, for a test that has to let something not happen. */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const write = async (box: HTMLElement, words: string) => {
  await toEnd(box);
  await userEvent.keyboard(literal(words));
};
export const boxText = (box: HTMLElement): string => markdownOf(editorOf(box));
type Key = "Enter" | "ArrowUp" | "ArrowDown";
export const press = async (box: HTMLElement, key: Key, init: KeyboardEventInit = {}) => {
  // A click would leave the caret where it landed; ↑ and ↓ recall only from the first or last line.
  if (document.activeElement !== box) await toEnd(box);
  const held = [
    init.shiftKey && "Shift",
    init.altKey && "Alt",
    init.metaKey && "Meta",
    init.ctrlKey && "Control",
  ].filter((k): k is string => typeof k === "string");
  await userEvent.keyboard(
    `${held.map((k) => `{${k}>}`).join("")}{${key}}${held
      .reverse()
      .map((k) => `{/${k}}`)
      .join("")}`,
  );
};
export const ready = (box: HTMLElement) =>
  waitFor(() => expect(box.getAttribute("contenteditable")).toBe("true"));
