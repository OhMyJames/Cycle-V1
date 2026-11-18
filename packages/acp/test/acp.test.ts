import { expect, test } from "bun:test";
import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_VERSION, SessionUpdate } from "../src/index.ts";

test("speaks ACP v2", () => {
  expect(PROTOCOL_VERSION).toBe(2);
});

test("names the methods L1 forwards", () => {
  expect(AGENT_METHODS.session_resume).toBe("session/resume");
  expect(AGENT_METHODS.session_prompt).toBe("session/prompt");
  expect(CLIENT_METHODS.session_update).toBe("session/update");
  expect(CLIENT_METHODS.session_request_permission).toBe("session/request_permission");
});

test("has no session/load: v2 resumes with replayFrom", () => {
  expect(Object.values(AGENT_METHODS)).not.toContain("session/load");
});

test("classifies a known update variant", () => {
  const update = { sessionUpdate: "replay_complete" } as const;
  expect(SessionUpdate.isReplayComplete(update as never)).toBe(true);
});
