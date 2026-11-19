import { expect, test } from "bun:test";
import { AGENT_METHODS, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2";

// A tripwire for upgrading the pinned SDK: L1 is built on these two facts about ACP v2.
test("is ACP v2, which resumes with replayFrom and has no session/load", () => {
  expect(PROTOCOL_VERSION).toBe(2);
  expect(AGENT_METHODS.session_resume).toBe("session/resume");
  expect(Object.values(AGENT_METHODS)).not.toContain("session/load");
});
