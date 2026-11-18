// Runs the adapter as a process, on the real Agent SDK and its bundled Claude binary, against a
// local mock of the Anthropic API. No account, no network. Run with:
//   bun run test:integration   (in packages/adapters/claude)
// It is not a *.test.ts, so the pre-commit gate does not run it: each run starts Claude processes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@cycle/acp";
import { tempConfigDir, withAdapter } from "./adapter-process.ts";
import {
  heldTextReply,
  type MockRequest,
  sentText,
  startMock,
  textReply,
  toolReply,
} from "./mock-anthropic.ts";

const ID = "7c1e2f30-1111-4222-8333-944455566677";
let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "cycle-v1-claude-cwd-"));
});
afterAll(() => rm(cwd, { recursive: true, force: true }));

const asked = (requests: MockRequest[]) => requests.filter((r) => r.path === "/v1/messages");

test("a turn streams over the real SDK", async () => {
  const mock = startMock(() => textReply("Hello from the mock."));
  const config = await tempConfigDir();
  try {
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir },
      async ({ agent, updates, idle }) => {
        const created = await agent.request(methods.agent.session.new, {
          cwd,
          _meta: { "cycle/sessionId": ID },
        });
        expect(created.sessionId).toBe(ID);
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: ID,
          prompt: [{ type: "text", text: "Say hello." }],
        });
        expect(await done).toMatchObject({ stopReason: "end_turn" });
        const text = updates
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => (u as unknown as { content: { text: string } }).content.text)
          .join("");
        expect(text).toBe("Hello from the mock.");
        console.log("update kinds:", updates.map((u) => u.sessionUpdate).join(", "));
      },
    );
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 60_000);

test("a new process resumes the session WITHOUT replayFrom, and the model has the context", async () => {
  const mock = startMock(() => textReply("Noted."));
  const config = await tempConfigDir();
  const id = "8d2f3041-2222-4333-8444-a55566677788";
  try {
    await withAdapter({ mockUrl: mock.url, configDir: config.dir }, async ({ agent, idle }) => {
      await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
      const done = idle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: id,
        prompt: [{ type: "text", text: "Remember the word PINEAPPLE." }],
      });
      await done;
    });
    // The first process is gone. A second one, with the same config directory, picks it up.
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir },
      async ({ agent, updates, idle }) => {
        await agent.request(methods.agent.session.resume, { sessionId: id, cwd });
        // ACP v2: the state comes before the answer, and no replay was asked for.
        expect(updates.map((u) => u.sessionUpdate)).toEqual(["state_update"]);
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "What was the word?" }],
        });
        await done;
      },
    );
    const last = asked(mock.requests).at(-1);
    const seen = sentText(last?.body);
    console.log("messages sent on the resumed turn:", seen.slice(0, 400));
    expect(seen).toContain("PINEAPPLE");
    expect(seen).toContain("What was the word?");
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 90_000);

test("a tool call asks permission through ACP, and the answer decides", async () => {
  for (const answer of ["allow", "deny"] as const) {
    const mock = startMock((requests) =>
      JSON.stringify(asked(requests).at(-1)?.body).includes("tool_result")
        ? textReply("Done.")
        : toolReply("Bash", { command: `touch created-by-${answer}.txt` }),
    );
    const config = await tempConfigDir();
    const id =
      answer === "allow"
        ? "9e304152-3333-4444-8555-b66677788899"
        : "af415263-4444-4555-8666-c7778889990a";
    try {
      await withAdapter(
        { mockUrl: mock.url, configDir: config.dir, onPermission: () => answer },
        async ({ agent, updates, permissions, idle }) => {
          await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: [{ type: "text", text: "Run echo." }],
          });
          expect(await done).toMatchObject({ stopReason: "end_turn" });
          expect(permissions).toHaveLength(1);
          console.log(answer, "permission request:", JSON.stringify(permissions[0]).slice(0, 300));
          const tool = updates.filter((u) => u.sessionUpdate === "tool_call_update") as unknown as {
            status?: string;
            content?: { content: { text: string } }[];
          }[];
          console.log(answer, "tool statuses:", tool.map((u) => u.status).join(", "));
          const last = tool.at(-1);
          if (answer === "allow") {
            expect(last?.status).toBe("completed");
          } else {
            expect(last?.status).toBe("failed");
          }
          // The answer really decided: the file exists only if the tool was allowed to run.
          expect(await Bun.file(join(cwd, `created-by-${answer}.txt`)).exists()).toBe(
            answer === "allow",
          );
        },
      );
    } finally {
      mock.stop();
      await config.dispose();
    }
  }
}, 120_000);

test("cancel, while the model is still writing, stops the turn and the rest never streams", async () => {
  const held = heldTextReply("The first part. ", "THE SECOND PART THAT MUST NOT ARRIVE.");
  const mock = startMock(() => held.body);
  const config = await tempConfigDir();
  const id = "b0526374-5555-4666-8777-d8889990aa1b";
  try {
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir },
      async ({ agent, updates, idle }) => {
        await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "Go." }],
        });
        // Wait until the first words have really streamed to the client.
        const started = Date.now();
        while (!updates.some((u) => u.sessionUpdate === "agent_message_chunk")) {
          if (Date.now() - started > 30_000) throw new Error("the model never started writing");
          await Bun.sleep(20);
        }
        const cancelledAt = Date.now();
        await agent.notify(methods.agent.session.cancel, { sessionId: id });
        const end = await Promise.race([
          done,
          Bun.sleep(8_000).then(() => {
            throw new Error("the turn did not end within 8s of the cancel");
          }),
        ]);
        console.log("ended", Date.now() - cancelledAt, "ms after the cancel:", JSON.stringify(end));
        expect(end).toMatchObject({ state: "idle", stopReason: "cancelled" });
        // Now let the model carry on. Nothing more may reach the client.
        held.release();
        await Bun.sleep(1_000);
        const text = updates
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => (u as unknown as { content: { text: string } }).content.text)
          .join("");
        expect(text).toContain("The first part.");
        expect(text).not.toContain("MUST NOT ARRIVE");
        expect(updates.at(-1)).toMatchObject({ state: "idle", stopReason: "cancelled" });
      },
    );
  } finally {
    held.release();
    mock.stop();
    await config.dispose();
  }
}, 60_000);
