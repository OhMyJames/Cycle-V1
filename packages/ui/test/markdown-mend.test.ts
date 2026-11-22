import { expect, test } from "bun:test";
import { inOpenFence, mendStreaming } from "../src/markdown-mend.ts";

test("a table's header row waits for its delimiter row", () => {
  expect(mendStreaming("Results:\n\n| a | b |")).toBe("Results:\n");
  expect(mendStreaming("| a | b")).toBe("");
});

test("a delimiter row being written is drawn whole", () => {
  expect(mendStreaming("Results:\n\n| a | b |\n| -")).toBe("Results:\n\n| a | b |\n| --- | --- |");
  expect(mendStreaming("| a | b | c |\n|---|:-")).toBe("| a | b | c |\n| --- | --- | --- |");
});

test("a table that is already a table is left as it is", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2";
  expect(mendStreaming(table)).toBe(table);
});

test("a mark with nothing after it is held back; one with text is Streamdown's", () => {
  expect(mendStreaming("This is **")).toBe("This is ");
  expect(mendStreaming("Run `")).toBe("Run ");
  expect(mendStreaming("Gone ~~")).toBe("Gone ");
  expect(mendStreaming("This is **bo")).toBe("This is **bo");
  expect(mendStreaming("a*b")).toBe("a*b");
});

test("nothing inside an open code fence is touched", () => {
  const code = "```ts\nconst a = 1 **\n| x |";
  expect(inOpenFence(code)).toBe(true);
  expect(mendStreaming(code)).toBe(code);
  expect(inOpenFence("```ts\nx\n```\n")).toBe(false);
  expect(inOpenFence("````\n```\n")).toBe(true);
});

test("a delimiter row with no dash yet holds its header back too", () => {
  expect(mendStreaming("Results:\n\n| a | b |\n|")).toBe("Results:\n");
  expect(mendStreaming("| a | b |\n| :")).toBe("");
});

test("a fence inside a list item is a fence", () => {
  const code = "1. Run:\n    ```sh\n    echo **";
  expect(inOpenFence(code)).toBe(true);
  expect(mendStreaming(code)).toBe(code);
});
