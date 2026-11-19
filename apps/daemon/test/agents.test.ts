import { expect, test } from "bun:test";
import { CLAUDE_PERMISSION_MODES } from "@cycle/harness-claude";
import { META } from "@cycle/protocol";
import { CLAUDE_CONFIG_SCHEMA } from "../src/claude-agent.ts";

test("Claude's settings list every mode the adapter takes, and leave the model open", () => {
  const { mode, model } = CLAUDE_CONFIG_SCHEMA.properties;
  // The daemon refuses a default that is not listed: a mode left out here could not be saved.
  expect(mode.oneOf.map((entry) => entry.const)).toEqual(
    CLAUDE_PERMISSION_MODES.map((m) => m.value),
  );
  // The model is any name Claude knows, not only the ones offered.
  expect((model as { _meta?: Record<string, unknown> })._meta?.[META.open]).toBe(true);
});
