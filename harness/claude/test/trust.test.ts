import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { createAgent } from "../src/index.ts";
import { claudeJsonPath, recordTrust } from "../src/trust.ts";
import { fakeQuery, textTurn } from "./fake-query.ts";

const ID = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

let config: string;
let work: string;
beforeEach(async () => {
  // Never the real ~/.claude: Claude's config directory is a temporary one.
  config = await mkdtemp(join(tmpdir(), "cycle-v1-test-"));
  work = await realpath(await mkdtemp(join(tmpdir(), "cycle-v1-test-")));
});
afterEach(async () => {
  await rm(config, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const projects = async (file: string) =>
  (JSON.parse(await readFile(file, "utf8")) as { projects?: Record<string, unknown> }).projects;

test("Claude's config directory is where it looks, and its home when there is none", () => {
  expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: "/c", HOME: "/h" })).toBe("/c/.claude.json");
  expect(claudeJsonPath({ HOME: "/h" })).toBe("/h/.claude.json");
  expect(claudeJsonPath({})).toBeUndefined();
});

test("the decision is added to what the file has, under the path and its real path, and only when it differs", async () => {
  const file = join(config, ".claude.json");
  await writeFile(file, JSON.stringify({ userID: "u", projects: { "/other": { x: 1 } } }));
  await mkdir(join(work, "real"));
  await symlink(join(work, "real"), join(work, "link"));

  expect(recordTrust(file, join(work, "link"), true)).toBe("written");
  const written = JSON.parse(await readFile(file, "utf8"));
  expect(written.userID).toBe("u");
  expect(written.projects).toEqual({
    "/other": { x: 1 },
    [join(work, "link")]: { hasTrustDialogAccepted: true },
    [join(work, "real")]: { hasTrustDialogAccepted: true },
  });
  expect(recordTrust(file, join(work, "link"), true)).toBe("unchanged");
  expect(recordTrust(file, join(work, "real"), false)).toBe("written");
  expect((await projects(file))?.[join(work, "real")]).toEqual({ hasTrustDialogAccepted: false });
});

test("a file that is not there is made, in a config directory not made yet; one that is not JSON is left alone", async () => {
  const fresh = join(config, "never-run", ".claude.json");
  expect(recordTrust(fresh, work, true)).toBe("written");
  expect(await projects(fresh)).toEqual({ [work]: { hasTrustDialogAccepted: true } });
  const file = join(config, ".claude.json");
  expect(recordTrust(file, work, true)).toBe("written");
  await writeFile(file, "{ broken");
  expect(recordTrust(file, work, false)).toMatchObject({ failed: expect.any(String) });
  expect(await readFile(file, "utf8")).toBe("{ broken");
});

/** Starts a session through the adapter, as the daemon would, and runs one turn. */
const runSession = async (meta: Record<string, unknown>) => {
  let seen: unknown;
  const fake = fakeQuery(async () => {
    // What the Claude process would read as it starts.
    seen = await projects(join(config, ".claude.json")).catch(() => undefined);
    return textTurn(ID, "msg_1", "ok");
  });
  const adapter = createAgent({ env: { CLAUDE_CONFIG_DIR: config } }, fake.run);
  let idle: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    idle = resolve;
  });
  const app = client().onNotification(methods.client.session.update, ({ params }) => {
    const update = params.update as { sessionUpdate: string; state?: string; stopReason?: string };
    if (update.sessionUpdate === "state_update" && update.stopReason !== undefined) idle();
  });
  await app.connectWith(adapter, async (agent) => {
    await agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "test", version: "0" },
    } as never);
    await agent.request(methods.agent.session.new, {
      cwd: work,
      _meta: { "cycle/sessionId": ID, ...meta },
    });
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "hi" }],
    });
    await ended;
  });
  return seen;
};

test("a session the daemon says is trusted has it on record before Claude starts", async () => {
  expect(await runSession({ "cycle/trusted": true })).toEqual({
    [work]: { hasTrustDialogAccepted: true },
  });
});

test("with no decision from the daemon, Claude's own record is not touched", async () => {
  expect(await runSession({})).toBeUndefined();
});
