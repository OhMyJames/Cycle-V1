import { expect, test } from "bun:test";
import { client, methods, type SessionUpdate } from "@cycle/acp";
import { type AdapterConfig, createAgent } from "../src/index.ts";
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
  onPermission?: () => "allow" | "deny" | "cancel" | Promise<never>,
  config: Partial<AdapterConfig> = {},
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
    .onRequest(methods.client.session.requestPermission, async () => {
      const answer = (await onPermission?.()) ?? "allow";
      return answer === "cancel"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: answer } };
    });
  const adapter = createAgent({ env: {}, ...config }, runQuery);
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

const prompt = async (
  agent: { request: (...args: never[]) => Promise<unknown> },
  waitForIdle: () => Promise<SessionUpdate>,
  text: string,
) => {
  const idle = waitForIdle();
  await ask(agent, methods.agent.session.prompt, {
    sessionId: ID,
    prompt: [{ type: "text", text }],
  });
  return idle;
};

const ask = (agent: unknown, method: unknown, params: unknown) =>
  (agent as { request: (m: unknown, p: unknown) => Promise<unknown> }).request(method, params);
const tell = (agent: unknown, method: unknown, params: unknown) =>
  (agent as { notify: (m: unknown, p: unknown) => Promise<void> }).notify(method, params);

const open = (agent: unknown) =>
  ask(agent, methods.agent.session.new, { cwd: "/work", _meta: { "cycle/sessionId": ID } });

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("later turns use the same process: one query, many prompts", async () => {
  const fake = fakeQuery(() => textTurn(ID, "msg_1", "Hi there"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    await prompt(agent as never, waitForIdle, "one");
    await prompt(agent as never, waitForIdle, "two");
  });
  expect(fake.calls).toHaveLength(1);
  expect(fake.prompts).toEqual(["one", "two"]);
});

test("when the process dies between turns, the next turn starts another and resumes the session", async () => {
  const fake = fakeQuery(() => textTurn(ID, "msg_1", "Hi there"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    await prompt(agent as never, waitForIdle, "one");
    fake.state.kill();
    await settle(20);
    await prompt(agent as never, waitForIdle, "two");
  });
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[0]?.options).toMatchObject({ sessionId: ID });
  expect(fake.calls[1]?.options).toMatchObject({ resume: ID });
  expect(fake.calls[1]?.options.sessionId).toBeUndefined();
});

test("when the process dies during a turn, that turn ends with an error, and the session goes on", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "one" ? new Promise(() => {}) : textTurn(ID, "m", "ok"),
  );
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    const idle = waitForIdle();
    await ask(agent, methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "one" }],
    });
    await settle(20);
    fake.state.kill(new Error("the Claude process died"));
    expect(await idle).toMatchObject({
      stopReason: "error",
      error: { message: "the Claude process died" },
    });
    expect(await prompt(agent as never, waitForIdle, "two")).toMatchObject({
      stopReason: "end_turn",
    });
  });
  expect(fake.calls).toHaveLength(2);
});

test("an idle process is let go, and the next prompt resumes the session", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      await open(agent);
      await prompt(agent as never, waitForIdle, "one");
      expect(fake.state.inputClosed).toBe(false);
      await settle(120);
      expect(fake.state.inputClosed).toBe(true);
      await prompt(agent as never, waitForIdle, "two");
    },
    undefined,
    { idleMs: 40 },
  );
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]?.options).toMatchObject({ resume: ID });
});

test("a process in the middle of a turn is not let go for being quiet", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeQuery(async () => {
    await gate;
    return textTurn(ID, "m", "late");
  });
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      await open(agent);
      const idle = waitForIdle();
      await ask(agent, methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text: "slow" }],
      });
      await settle(120);
      expect(fake.state.inputClosed).toBe(false);
      release();
      expect(await idle).toMatchObject({ stopReason: "end_turn" });
    },
    undefined,
    { idleMs: 40 },
  );
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

test("a second prompt right after the first is refused: the turn exists before anything is awaited", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeQuery(async () => {
    await gate;
    return textTurn(ID, "m", "done");
  });
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "one" }],
    });
    await expect(
      agent.request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text: "two" }],
      }),
    ).rejects.toMatchObject({ code: -32600 });
    release();
    await idle;
  });
  expect(fake.calls).toHaveLength(1);
});

test("a cancel sent straight after the prompt ends the turn as cancelled, and stops the query", async () => {
  const fake = fakeQuery(() => new Promise(() => {}));
  await connect(fake.run, async ({ agent, updates, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "go" }],
    });
    // No await between the answer and the cancel: it may beat the query's start.
    await agent.notify(methods.agent.session.cancel, { sessionId: ID });
    expect(await idle).toMatchObject({ state: "idle", stopReason: "cancelled" });
    expect(updates.at(-1)).toMatchObject({ stopReason: "cancelled" });
  });
  // Either it never started, or it was interrupted: it did not run on.
  expect(fake.calls.length === 0 || fake.state.interrupts === 1).toBe(true);
});

test("after a cancel the session can take another prompt", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "first" ? new Promise(() => {}) : textTurn(ID, "m", "ok"),
  );
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    let idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "first" }],
    });
    await agent.notify(methods.agent.session.cancel, { sessionId: ID });
    await idle;
    idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "second" }],
    });
    expect(await idle).toMatchObject({ stopReason: "end_turn" });
  });
});

test("a mode or model set while the process runs is sent to it; one that cannot be sent lets the process go", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    await prompt(agent as never, waitForIdle, "one");
    const request = (m: unknown, p: unknown) => ask(agent, m, p);
    await request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "mode",
      type: "id",
      value: "acceptEdits",
    });
    await request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "model",
      type: "id",
      value: "haiku",
    });
    await settle(10);
    expect(fake.state.permissionModes).toEqual(["acceptEdits"]);
    expect(fake.state.models).toEqual(["haiku"]);
    expect(fake.calls).toHaveLength(1);

    fake.state.failSetters = true;
    await request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "mode",
      type: "id",
      value: "plan",
    });
    await settle(20);
    await prompt(agent as never, waitForIdle, "two");
  });
  // The second process has the new mode and the model in its options.
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]?.options).toMatchObject({
    permissionMode: "plan",
    model: "haiku",
    resume: ID,
  });
});

test("a cancel keeps the process: the next prompt goes to the same one", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "first" ? new Promise(() => {}) : textTurn(ID, "m", "ok"),
  );
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    const idle = waitForIdle();
    const request = (m: unknown, p: unknown) => ask(agent, m, p);
    await request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "first" }],
    });
    await settle(20);
    await tell(agent, methods.agent.session.cancel, { sessionId: ID });
    expect(await idle).toMatchObject({ stopReason: "cancelled" });
    expect(await prompt(agent as never, waitForIdle, "second")).toMatchObject({
      stopReason: "end_turn",
    });
  });
  expect(fake.calls).toHaveLength(1);
  expect(fake.state.interrupts).toBe(1);
});

test("a process that ignores the interrupt is killed after the grace period, and the next prompt starts another", async () => {
  const fake = fakeQuery((call) =>
    // It has started (init) and then says nothing: a hung process.
    call.prompt === "first" ? textTurn(ID, "m", "x").slice(0, 1) : textTurn(ID, "m", "ok"),
  );
  fake.state.ignoreInterrupt = true;
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      await open(agent);
      const idle = waitForIdle();
      const request = (m: unknown, p: unknown) => ask(agent, m, p);
      await request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text: "first" }],
      });
      await settle(20);
      await tell(agent, methods.agent.session.cancel, { sessionId: ID });
      expect(await idle).toMatchObject({ stopReason: "cancelled" });
      fake.state.ignoreInterrupt = false;
      expect(await prompt(agent as never, waitForIdle, "second")).toMatchObject({
        stopReason: "end_turn",
      });
    },
    undefined,
    { cancelGraceMs: 50 },
  );
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]?.options).toMatchObject({ resume: ID });
});

test("a cancel while a permission is waiting for an answer ends the question and the turn", async () => {
  let asked: Promise<unknown> | undefined;
  const fake = fakeQuery(async (call) => {
    asked = call.options.canUseTool?.("Bash", { command: "touch x" }, {
      signal: new AbortController().signal,
      toolUseID: "tool_1",
    } as never);
    await asked;
    return textTurn(ID, "m", "done");
  });
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      await open(agent);
      const idle = waitForIdle();
      const request = (m: unknown, p: unknown) => ask(agent, m, p);
      await request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text: "go" }],
      });
      await settle(30);
      await tell(agent, methods.agent.session.cancel, { sessionId: ID });
      expect(await idle).toMatchObject({ stopReason: "cancelled" });
      // The question was answered as cancelled, not left hanging.
      expect(await asked).toMatchObject({ behavior: "deny" });
    },
    () => new Promise<never>(() => {}),
  );
});

/** The adapter, told by a stand-in for the SDK's `getSessionInfo` whether Claude has the session on disk. */
const resumed = async (
  record: "found" | "none" | "fails" | "cannot look",
  meta: Record<string, unknown> = {},
) => {
  const fake = fakeQuery(() => textTurn(ID, "m", "again"));
  let outcome: unknown;
  const sessionInfo =
    record === "cannot look"
      ? {}
      : {
          sessionInfo: async () => {
            if (record === "fails") throw new Error("cannot read the config directory");
            return record === "found" ? ({ summary: "s", firstPrompt: "s" } as never) : undefined;
          },
        };
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      try {
        await agent.request(methods.agent.session.resume, {
          sessionId: ID,
          cwd: "/work",
          _meta: meta,
        });
      } catch (error) {
        outcome = error;
        return;
      }
      const idle = waitForIdle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text: "first" }],
      });
      await idle;
    },
    undefined,
    sessionInfo,
  );
  return { fake, outcome };
};

test("a session Claude has on disk is resumed", async () => {
  const { fake } = await resumed("found");
  expect(fake.calls[0]?.options).toMatchObject({ resume: ID });
});

test("a session Claude never wrote (made, and no prompt sent) is started, not resumed", async () => {
  const { fake, outcome } = await resumed("none");
  expect(outcome).toBeUndefined();
  expect(fake.calls[0]?.options.resume).toBeUndefined();
  expect(fake.calls[0]?.options).toMatchObject({ sessionId: ID });
});

test("a session that had a turn answered and has no record any more is not started over: the resume says so", async () => {
  const { fake, outcome } = await resumed("none", { "cycle/hadTurn": true });
  expect(outcome).toMatchObject({ code: -32603 });
  expect(String((outcome as Error).message)).toContain("no record");
  expect(fake.calls).toHaveLength(0);
});

test("a session that had a turn answered and is on disk is resumed", async () => {
  const { fake } = await resumed("found", { "cycle/hadTurn": true });
  expect(fake.calls[0]?.options).toMatchObject({ resume: ID });
});

test("where the record cannot be looked at, the session is taken to be there, as it was before", async () => {
  for (const record of ["fails", "cannot look"] as const) {
    const { fake } = await resumed(record);
    expect(fake.calls[0]?.options).toMatchObject({ resume: ID });
  }
});
