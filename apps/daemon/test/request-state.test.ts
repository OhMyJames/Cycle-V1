import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { Daemon } from "../src/index.ts";
import { connectClient, type Seen, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  await dispose();
});

/** The states a client was told by snapshot: a state_update with no seq and no stopReason. */
const snapshots = (seen: Seen[]) =>
  seen
    .filter((s) => s.seq === undefined && s.update.sessionUpdate === "state_update")
    .map((s) => (s.update as { state?: string; stopReason?: string }).state);

test("a client attached throughout is told the session waits on the person, and that it no longer does", async () => {
  // The agent says nothing of its own about waiting, as Claude's adapter does not.
  let answered: unknown;
  const fake = fakeAgent({
    onPrompt: async ({ ask }) => {
      answered = await ask();
    },
  });
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  const c = await connectClient(daemon, {
    onPermission: () => "never",
  });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  const before = snapshots(c.seen).length;
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "go" }],
  });
  await until(() => c.permissions.length === 1, "the request");
  await until(() => snapshots(c.seen).length === before + 1, "the state it is in");
  expect(snapshots(c.seen).at(-1)).toBe("requires_action");

  // Answered by another client: this one is told it no longer waits.
  const other = await connectClient(daemon, { onPermission: () => "allow" });
  await other.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await until(() => answered !== undefined, "the agent to be answered");
  await until(() => snapshots(c.seen).includes("running"), "the state after the answer");
  expect(snapshots(c.seen).slice(before)).toEqual(["requires_action", "running"]);
  // A snapshot, not a record: the history has no such state.
  const log = await readFile(join(dir, "sessions", `${sessionId}.jsonl`), "utf8");
  expect(log).not.toContain('"requires_action"');
  await daemon.close();
});
