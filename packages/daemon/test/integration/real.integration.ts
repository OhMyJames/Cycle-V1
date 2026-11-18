// The daemon and the Claude adapter against a real model, with the daemon restarted in the middle.
// Not part of `bun run test:integration`: it spends a little of an account's quota. Run it with the
// credential given on purpose:
//
//   CYCLE_REAL_MODEL_TOKEN=<oauth token> bun test ./test/integration/real.integration.ts   (in packages/daemon)
//
// The token is in the Claude process's environment and nowhere else.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, type SessionUpdate } from "@cycle/acp";
import { applyUpdate, emptyConversation } from "../../../ui/src/model/index.ts";
import { Daemon, processAgent } from "../../src/index.ts";
import { connectClient, until } from "../client.ts";

const token = process.env.CYCLE_REAL_MODEL_TOKEN;
const model = process.env.CYCLE_REAL_MODEL ?? "haiku";
const enabled = token !== undefined && token !== "";
const adapter = new URL("../../../adapters/claude/src/main.ts", import.meta.url).pathname;

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cycle-v1-real-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

const claude = (configDir: string) =>
  processAgent({
    id: "claude",
    name: "Claude",
    command: ["bun", adapter],
    env: {
      PATH: process.env.PATH ?? "",
      CYCLE_ADAPTER_CONFIG: JSON.stringify({
        env: {
          PATH: process.env.PATH ?? "",
          HOME: configDir,
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_OAUTH_TOKEN: token as string,
        },
      }),
    },
  });

const say = (text: string) => [{ type: "text" as const, text }];
const ended = (seen: { update: SessionUpdate }[]) =>
  seen.filter((s) => (s.update as { stopReason?: string }).stopReason !== undefined).length;

test.skipIf(!enabled)(
  "a real session through the daemon: a permission, a restart of the daemon, history from disk, and context",
  async () => {
    const dataDir = join(root, "data");
    const configDir = join(root, "claude");
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    const open: Daemon[] = [];
    try {
      const first = await Daemon.start({ dataDir, agents: [claude(configDir)] });
      open.push(first);
      const c = await connectClient(first, { onPermission: () => "allow" });
      const { sessionId } = await c.agent.request(methods.agent.session.new, {
        cwd,
        _meta: { "cycle/config": { model } },
      });
      await c.agent.request(methods.agent.session.resume, { sessionId, cwd });

      await c.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: say(
          "Remember this code word: ZEPPELIN. Then use the Bash tool to run exactly: touch from-the-daemon.txt  and say finished.",
        ),
      });
      await until(() => ended(c.seen) >= 1, "the first turn", 60_000);
      console.log(
        "REAL daemon turn 1 kinds:",
        JSON.stringify(
          Object.fromEntries(
            [...new Set(c.kinds())].map((k) => [k, c.kinds().filter((x) => x === k).length]),
          ),
        ),
      );
      expect(c.permissions.length).toBeGreaterThan(0);
      expect(existsSync(join(cwd, "from-the-daemon.txt"))).toBe(true);

      // The daemon goes away, and with it the Claude process. Only the disk is left.
      await first.close();
      open.length = 0;
      const second = await Daemon.start({ dataDir, agents: [claude(configDir)] });
      open.push(second);
      const d = await connectClient(second);
      const listed = await d.agent.request(methods.agent.session.list, {});
      expect(((listed.sessions[0]?._meta ?? {}) as Record<string, unknown>)["cycle/state"]).toBe(
        "stopped",
      );
      await d.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });

      // What the real model sent, read back from the log, reduced as the interface will.
      const replayed = d.seen.map((s) => s.update);
      const conversation = replayed.reduce(applyUpdate, emptyConversation());
      console.log(
        "REAL history: ",
        JSON.stringify({
          items: conversation.items.map((i) => i.kind),
          turns: conversation.turns,
          ignored: conversation.ignored,
          status: conversation.status,
        }),
      );
      expect(conversation.ignored).toBe(0);
      expect(conversation.turns).toBe(1);
      expect(conversation.items.map((i) => i.kind)).toContain("tool");
      expect(conversation.items.map((i) => i.kind)).toContain("user");

      // And the conversation goes on, with Claude started again and the session resumed.
      const before = ended(d.seen);
      await d.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: say("What was the code word? Answer with the word only."),
      });
      await until(() => ended(d.seen) > before, "the turn after the restart", 60_000);
      const answer = d.seen
        .map((s) => s.update as unknown as { sessionUpdate: string; content?: { text?: string } })
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content?.text ?? "")
        .join("");
      console.log("REAL after restart:", JSON.stringify(answer.slice(-80)));
      expect(answer.toUpperCase()).toContain("ZEPPELIN");
    } finally {
      for (const daemon of open) await daemon.close();
    }
  },
  180_000,
);
