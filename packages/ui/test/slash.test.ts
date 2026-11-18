import { expect, test } from "bun:test";
import { commandText, filterCommands, slashQuery } from "../src/slash.ts";

const commands = [
  { name: "init", description: "Set up" },
  { name: "review", description: "Review a change", hint: "PR number" },
  { name: "pr-review", description: "Review a pull request" },
  { name: "compact", description: "Free up context" },
];

test("a command is being typed only at the start of the first block, and only up to a space", () => {
  expect(slashQuery("/", true)).toBe("");
  expect(slashQuery("/rev", true)).toBe("rev");
  expect(slashQuery("/review ", true)).toBeUndefined();
  expect(slashQuery("/review 12", true)).toBeUndefined();
  expect(slashQuery("see /rev", true)).toBeUndefined();
  expect(slashQuery("/rev", false)).toBeUndefined();
  expect(slashQuery("src/rev", true)).toBeUndefined();
  expect(slashQuery("", true)).toBeUndefined();
});

test("names that start with the query come before names that hold it", () => {
  expect(filterCommands(commands, "rev").map((c) => c.name)).toEqual(["review", "pr-review"]);
  expect(filterCommands(commands, "").map((c) => c.name)).toEqual([
    "init",
    "review",
    "pr-review",
    "compact",
  ]);
  expect(filterCommands(commands, "REV").map((c) => c.name)).toEqual(["review", "pr-review"]);
  expect(filterCommands(commands, "zzz")).toEqual([]);
});

test("a chosen command is followed by a space, where its input goes", () => {
  expect(commandText({ name: "review", description: "" })).toBe("/review ");
});
