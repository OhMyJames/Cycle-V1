// The adapter against a real model. Not part of `bun run test:integration`: it spends a little of an
// account's quota, so it only runs when asked, with the credential given on purpose:
//
//   CYCLE_REAL_MODEL_TOKEN=<oauth token> bun run test:real     (in packages/adapters/claude)
//
// The token goes into the Claude process's environment and nowhere else: not the adapter's, not the
// log. The model is small (CYCLE_REAL_MODEL, default "haiku"). The assertions are loose, because a
// real model is not deterministic; what this is for is the printed report of what really happened.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, type SessionUpdate } from "@cycle/acp";
import { tempConfigDir, withAdapter } from "./adapter-process.ts";

const token = process.env.CYCLE_REAL_MODEL_TOKEN;
const model = process.env.CYCLE_REAL_MODEL ?? "haiku";
const enabled = token !== undefined && token !== "";

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "cycle-v1-real-cwd-"));
  await writeFile(join(cwd, "notes.txt"), "The secret word in this file is MARMALADE.\n");
});
afterAll(() => rm(cwd, { recursive: true, force: true }));

/** The only environment the Claude process gets. */
const claudeEnv = (configDir: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: configDir,
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_OAUTH_TOKEN: token as string,
});

const say = (text: string) => [{ type: "text" as const, text }];
const kinds = (updates: SessionUpdate[]) => {
  const count: Record<string, number> = {};
  for (const u of updates) count[u.sessionUpdate] = (count[u.sessionUpdate] ?? 0) + 1;
  return count;
};
const agentText = (updates: SessionUpdate[]) =>
  updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_message")
    .map((u) => {
      const c = (u as unknown as { content: { text?: string } | { text?: string }[] }).content;
      return Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : (c.text ?? "");
    })
    .join("");
const last = (updates: SessionUpdate[]) =>
  updates.filter((u) => (u as { stopReason?: string }).stopReason !== undefined).at(-1) as
    | { stopReason: string; error?: unknown }
    | undefined;

const ID = (n: number) => `1000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;

test.skipIf(!enabled)(
  "a real turn: streamed text, how it ends, and every kind of update seen",
  async () => {
    const config = await tempConfigDir();
    try {
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir) },
        async ({ agent, updates, idle }) => {
          await agent.request(methods.agent.session.new, {
            cwd,
            _meta: { "cycle/sessionId": ID(1) },
          });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: ID(1),
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          const started = Date.now();
          await agent.request(methods.agent.session.prompt, {
            sessionId: ID(1),
            prompt: say("Reply with exactly the single word PINEAPPLE and nothing else."),
          });
          await done;
          console.log(`REAL turn: ${Date.now() - started} ms, model ${model}`);
          console.log("REAL update kinds:", JSON.stringify(kinds(updates)));
          console.log("REAL text:", JSON.stringify(agentText(updates)));
          console.log("REAL ended:", JSON.stringify(last(updates)));
          expect(last(updates)?.stopReason).toBe("end_turn");
          expect(agentText(updates).toUpperCase()).toContain("PINEAPPLE");

          // The second turn goes to the same process: it should not pay for a start.
          for (const n of [2, 3]) {
            const again = idle();
            const t = Date.now();
            await agent.request(methods.agent.session.prompt, {
              sessionId: ID(1),
              prompt: say("Reply with exactly the single word PINEAPPLE and nothing else."),
            });
            await again;
            console.log(`REAL turn ${n}: ${Date.now() - t} ms (same process)`);
            expect(last(updates)?.stopReason).toBe("end_turn");
          }
        },
      );
    } finally {
      await config.dispose();
    }
  },
  90_000,
);

test.skipIf(!enabled)(
  "a real tool call asks, and the answer decides: allow runs it, deny does not",
  async () => {
    for (const answer of ["allow", "deny"] as const) {
      const config = await tempConfigDir();
      const file = `real-model-${answer}.txt`;
      try {
        await withAdapter(
          { configDir: config.dir, env: claudeEnv(config.dir), onPermission: () => answer },
          async ({ agent, updates, permissions, idle }) => {
            const id = ID(answer === "allow" ? 2 : 3);
            await agent.request(methods.agent.session.new, {
              cwd,
              _meta: { "cycle/sessionId": id },
            });
            await agent.request(methods.agent.session.setConfigOption, {
              sessionId: id,
              configId: "model",
              type: "id",
              value: model,
            } as never);
            const done = idle();
            await agent.request(methods.agent.session.prompt, {
              sessionId: id,
              prompt: say(
                `Use the Bash tool to run exactly: touch ${file}   Then reply with the word finished.`,
              ),
            });
            await done;
            console.log(`REAL ${answer}: kinds`, JSON.stringify(kinds(updates)));
            console.log(
              `REAL ${answer}: permission request`,
              JSON.stringify(permissions[0]).slice(0, 400),
            );
            const tools = updates.filter(
              (u) => u.sessionUpdate === "tool_call_update",
            ) as unknown as { name?: string; kind?: string; status?: string }[];
            console.log(
              `REAL ${answer}: tool updates`,
              JSON.stringify(tools.map((t) => [t.name, t.kind, t.status])),
            );
            console.log(
              `REAL ${answer}: ended`,
              JSON.stringify(last(updates)),
              "text:",
              JSON.stringify(agentText(updates)).slice(0, 200),
            );
            expect(permissions.length).toBeGreaterThan(0);
            expect(existsSync(join(cwd, file))).toBe(answer === "allow");
          },
        );
      } finally {
        await config.dispose();
      }
    }
  },
  120_000,
);

test.skipIf(!enabled)(
  "a real model reads a file, and a new process resumes the session with its context",
  async () => {
    const config = await tempConfigDir();
    const id = ID(4);
    try {
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir) },
        async ({ agent, updates, idle }) => {
          await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say(
              "Read the file notes.txt with the Read tool and tell me the secret word in it.",
            ),
          });
          await done;
          console.log("REAL read: kinds", JSON.stringify(kinds(updates)));
          const tools = updates.filter(
            (u) => u.sessionUpdate === "tool_call_update",
          ) as unknown as { name?: string; kind?: string; status?: string; content?: unknown }[];
          console.log(
            "REAL read: tools",
            JSON.stringify(tools.map((t) => [t.name, t.kind, t.status])),
          );
          console.log(
            "REAL read: tool output shape",
            JSON.stringify(tools.find((t) => t.content)?.content).slice(0, 300),
          );
          console.log(
            "REAL read: ended",
            JSON.stringify(last(updates)),
            JSON.stringify(agentText(updates)).slice(0, 200),
          );
          expect(agentText(updates).toUpperCase()).toContain("MARMALADE");
        },
      );
      // The first process is gone. A second one has the same config directory and resumes the session.
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir) },
        async ({ agent, updates, idle }) => {
          await agent.request(methods.agent.session.resume, { sessionId: id, cwd });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say("What was the secret word? Answer with the word only."),
          });
          await done;
          console.log(
            "REAL resumed: ended",
            JSON.stringify(last(updates)),
            "text:",
            JSON.stringify(agentText(updates)),
          );
          expect(last(updates)?.stopReason).toBe("end_turn");
          expect(agentText(updates).toUpperCase()).toContain("MARMALADE");
        },
      );
    } finally {
      await config.dispose();
    }
  },
  150_000,
);

test.skipIf(!enabled)(
  "a real model stopped part way: cancel ends the turn promptly and nothing more arrives",
  async () => {
    const config = await tempConfigDir();
    const id = ID(5);
    try {
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir) },
        async ({ agent, updates, idle }) => {
          await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say("Count from 1 to 300, one number per line, with no other text."),
          });
          const started = Date.now();
          while (
            !updates.some((u) => u.sessionUpdate === "agent_message_chunk") &&
            Date.now() - started < 60_000
          )
            await Bun.sleep(20);
          const cancelledAt = Date.now();
          await agent.notify(methods.agent.session.cancel, { sessionId: id });
          await Promise.race([
            done,
            Bun.sleep(15_000).then(() =>
              Promise.reject(new Error("the turn did not end within 15s of the cancel")),
            ),
          ]);
          const took = Date.now() - cancelledAt;
          const seenAtEnd = updates.length;
          await Bun.sleep(3_000);
          console.log(
            `REAL cancel: ended ${took} ms after the cancel; ${updates.length - seenAtEnd} updates arrived afterwards`,
          );
          console.log("REAL cancel: ended", JSON.stringify(last(updates)));
          expect(last(updates)?.stopReason).toBe("cancelled");
          expect(updates.length).toBe(seenAtEnd);
          // And the session still works.
          const again = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say("Reply with the word OK."),
          });
          await again;
          console.log(
            "REAL after cancel: ended",
            JSON.stringify(last(updates)),
            JSON.stringify(agentText(updates)).slice(-60),
          );
          expect(last(updates)?.stopReason).toBe("end_turn");
        },
      );
    } finally {
      await config.dispose();
    }
  },
  150_000,
);
