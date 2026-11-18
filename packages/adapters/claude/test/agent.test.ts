import { expect, test } from "bun:test";
import { client, methods, type SessionUpdate } from "@cycle/acp";
import { createAgent } from "../src/index.ts";
import { fakeQuery, textTurn } from "./fake-query.ts";

const ID = "5b0c3a3e-8a52-4d3f-9a0e-1c2d3e4f5a6b";

/** An ACP client wired straight to the adapter in this process. */
const connect = async <T>(
  runQuery: ReturnType<typeof fakeQuery>["run"],
  body: (api: {
    agent: Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0];
    updates: SessionUpdate[];
    waitForIdle: () => Promise<SessionUpdate>;
  }) => Promise<T>,
  onPermission?: () => "allow" | "deny" | "cancel",
): Promise<T> => {
  const updates: SessionUpdate[] = [];
  const waiting: ((u: SessionUpdate) => void)[] = [];
  const app = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      const update = params.update as { sessionUpdate: string; state?: string };
      if (update.sessionUpdate === "state_update" && update.state === "idle") {
        for (const resolve of waiting.splice(0)) resolve(params.update);
      }
    })
    .onRequest(methods.client.session.requestPermission, () => {
      const answer = onPermission?.() ?? "allow";
      return answer === "cancel"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: answer } };
    });
  const adapter = createAgent({ env: {} }, runQuery);
  return app.connectWith(adapter, async (agent) => {
    await agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "test", version: "0" },
    } as never);
    return body({
      agent,
      updates,
      waitForIdle: () => new Promise((resolve) => waiting.push(resolve)),
    });
  });
};

const kinds = (updates: SessionUpdate[]) => updates.map((u) => u.sessionUpdate);

test("a prompt answers at once, then streams, and ends with an idle state_update", async () => {
  const fake = fakeQuery(() => textTurn(ID, "msg_1", "Hello there"));
  await connect(fake.run, async ({ agent, updates, waitForIdle }) => {
    const created = await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    // The agent took the id the daemon proposed.
    expect(created.sessionId).toBe(ID);

    const idle = waitForIdle();
    const answer = await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "Say hello" }],
    });
    expect(answer.messageId).toBeString();
    const end = await idle;
    expect(end).toMatchObject({ state: "idle", stopReason: "end_turn" });

    expect(kinds(updates)).toEqual([
      "user_message",
      "state_update",
      "agent_message_chunk",
      "agent_message_chunk",
      "state_update",
    ]);
    // The user message carries the id the prompt answered with.
    expect(updates[0]).toMatchObject({ messageId: answer.messageId });
    expect(updates[1]).toMatchObject({ state: "running" });
  });
  // First turn creates the session under the proposed id.
  expect(fake.calls[0]?.options).toMatchObject({ sessionId: ID });
  expect(fake.calls[0]?.options.resume).toBeUndefined();
  expect(fake.calls[0]?.options.env).toEqual({});
});

test("the second turn resumes the session instead of creating it", async () => {
  const fake = fakeQuery(() => textTurn(ID, "msg_1", "Hi there"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    for (const text of ["one", "two"]) {
      const idle = waitForIdle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text }],
      });
      await idle;
    }
  });
  expect(fake.calls[1]?.options).toMatchObject({ resume: ID });
  expect(fake.calls[1]?.options.sessionId).toBeUndefined();
});

test("makes its own id when the proposed one is not a UUID", async () => {
  const fake = fakeQuery(() => []);
  await connect(fake.run, async ({ agent }) => {
    const created = await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": "not-a-uuid" },
    });
    expect(created.sessionId).not.toBe("not-a-uuid");
    expect(created.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

test("resuming in a new process sends the state before it answers, and no replay", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "again"));
  await connect(fake.run, async ({ agent, updates, waitForIdle }) => {
    const before = updates.length;
    await agent.request(methods.agent.session.resume, { sessionId: ID, cwd: "/work" });
    expect(kinds(updates.slice(before))).toEqual(["state_update"]);
    expect(updates.at(-1)).toMatchObject({ state: "idle" });
    // It was not created in this process, so the first turn resumes it.
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "go on" }],
    });
    await idle;
  });
  expect(fake.calls[0]?.options).toMatchObject({ resume: ID });
});

test("refuses to replay: the daemon owns the history", async () => {
  const fake = fakeQuery(() => []);
  await connect(fake.run, async ({ agent }) => {
    await expect(
      agent.request(methods.agent.session.resume, {
        sessionId: ID,
        cwd: "/work",
        replayFrom: { type: "start" },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

test("a prompt for an unknown session is session-not-found", async () => {
  const fake = fakeQuery(() => []);
  await connect(fake.run, async ({ agent }) => {
    await expect(
      agent.request(methods.agent.session.prompt, {
        sessionId: "nope",
        prompt: [{ type: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({ code: -32002 });
  });
});

test("a turn that throws ends idle with an error", async () => {
  const fake = fakeQuery(() => {
    throw new Error("the model fell over");
  });
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(await idle).toMatchObject({
      state: "idle",
      stopReason: "error",
      error: { message: "the model fell over" },
    });
  });
});

test("changes the permission mode, and refuses one it does not know", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const set = await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "mode",
      type: "id",
      value: "plan",
    } as never);
    expect(JSON.stringify(set.configOptions)).toContain('"currentValue":"plan"');
    await expect(
      agent.request(methods.agent.session.setConfigOption, {
        sessionId: ID,
        configId: "mode",
        type: "id",
        value: "bypassPermissions",
      } as never),
    ).rejects.toMatchObject({ code: -32602 });
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "x" }],
    });
    await idle;
  });
  expect(fake.calls[0]?.options.permissionMode).toBe("plan");
});
