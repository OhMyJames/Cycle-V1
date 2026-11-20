import { expect, test } from "bun:test";
import {
  client,
  methods,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type AdapterConfig, createAgent } from "../src/index.ts";
import { fakeQuery, textTurn } from "./fake-query.ts";

const ID = "5b0c3a3e-8a52-4d3f-9a0e-1c2d3e4f5a6b";

type Answers = {
  /** The client does not say it can answer forms (it would refuse one if sent). */
  noCapability?: boolean;
  /** The client says it can, and then fails the request, as a host that does not know the method would. */
  failElicitation?: boolean;
  /** What a client with the elicitation capability would answer; absent: the daemon with no such client. */
  elicitation?: (params: Record<string, unknown>) => Record<string, unknown>;
  permission?: (params: Record<string, unknown>) => "allow" | "deny";
};

/** An ACP client wired straight to the adapter, answering what it is asked as `answers` says. */
const connect = async <T>(
  runQuery: ReturnType<typeof fakeQuery>["run"],
  body: (api: {
    agent: Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0];
    updates: SessionUpdate[];
    asked: { elicitation: Record<string, unknown>[]; permission: Record<string, unknown>[] };
    idle: () => Promise<void>;
  }) => Promise<T>,
  answers: Answers = {},
  config: Partial<AdapterConfig> = {},
): Promise<T> => {
  const updates: SessionUpdate[] = [];
  const asked = {
    elicitation: [] as Record<string, unknown>[],
    permission: [] as Record<string, unknown>[],
  };
  let idles = 0;
  const waiting: (() => void)[] = [];
  const app = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      const update = params.update as { sessionUpdate: string; state?: string };
      if (update.sessionUpdate === "state_update" && update.state === "idle") {
        idles++;
        for (const resolve of waiting.splice(0)) resolve();
      }
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      asked.permission.push(params as never);
      const answer = answers.permission?.(params as never) ?? "allow";
      return { outcome: { outcome: "selected", optionId: answer } };
    })
    .onRequest(methods.client.elicitation.create, async ({ params }) => {
      asked.elicitation.push(params as never);
      if (answers.failElicitation) throw new RequestError(-32601, "Method not found");
      return (answers.elicitation?.(params as never) ?? {
        action: "cancel",
        _meta: { "cycle/noClient": true },
      }) as never;
    });
  const adapter = createAgent({ env: {}, ...config }, runQuery);
  return app.connectWith(adapter, async (agent) => {
    await agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "test", version: "0" },
      capabilities: answers.noCapability ? {} : { elicitation: { form: {} } },
    } as never);
    return body({
      agent,
      updates,
      asked,
      idle: async () => {
        const seen = idles;
        if (idles > seen) return;
        await new Promise<void>((resolve) => waiting.push(resolve));
      },
    });
  });
};

type Requester = { request: (method: string, params: unknown) => Promise<unknown> };

const kinds = (updates: SessionUpdate[]) => updates.map((u) => u.sessionUpdate);
const png = Buffer.from("not really a png").toString("base64");

const newSession = (agent: Requester, extra: Record<string, unknown> = {}) =>
  agent.request(methods.agent.session.new, {
    cwd: "/work",
    _meta: { "cycle/sessionId": ID },
    ...extra,
  });

const prompt = async (agent: Requester, idle: () => Promise<void>, content: unknown[]) => {
  const waiting = idle();
  await agent.request(methods.agent.session.prompt, { sessionId: ID, prompt: content });
  await waiting;
};

// ---- attachments ----

test("the adapter says what a prompt may carry, and what a session may be started with", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  const adapter = createAgent({ env: {} }, fake.run);
  const app = client();
  const init = await app.connectWith(adapter, (agent) =>
    agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "t", version: "0" },
    } as never),
  );
  expect((init as { capabilities: { session: unknown } }).capabilities.session).toMatchObject({
    prompt: { image: {}, embeddedContext: {} },
    mcp: { stdio: {}, http: {} },
    additionalDirectories: {},
    systemPrompt: {},
  });
});

test("images, PDFs, text files and links reach Claude as content, not as nothing", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await prompt(agent, idle, [
      { type: "text", text: "what is this?" },
      { type: "image", data: png, mimeType: "image/png" },
      {
        type: "resource",
        resource: { uri: "file:///notes.md", mimeType: "text/markdown", text: "# notes" },
      },
      {
        type: "resource",
        resource: { uri: "file:///a.pdf", mimeType: "application/pdf", blob: png },
      },
      { type: "resource_link", name: "log", uri: "file:///var/log/x" },
    ]);
  });
  expect(fake.contents[0]).toEqual([
    { type: "text", text: "what is this?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
    { type: "text", text: '<file uri="file:///notes.md">\n# notes\n</file>' },
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: png },
      title: "file:///a.pdf",
    },
    { type: "text", text: '<mention name="log" uri="file:///var/log/x"/>' },
  ]);
});

test("text and links alone stay a string, as before", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await prompt(agent, idle, [
      { type: "text", text: "see" },
      { type: "resource_link", name: "a", uri: "file:///a" },
    ]);
  });
  expect(fake.contents[0]).toBe('see\n\n<mention name="a" uri="file:///a"/>');
});

test("a block it cannot carry refuses the prompt, and the session takes the next one", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await expect(
      agent.request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [
          { type: "text", text: "listen" },
          { type: "audio", data: "AAAA", mimeType: "audio/wav" },
        ],
      } as never),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      agent.request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [
          {
            type: "resource",
            resource: { uri: "file:///a.zip", mimeType: "application/zip", blob: png },
          },
        ],
      } as never),
    ).rejects.toMatchObject({ code: -32602 });
    await prompt(agent, idle, [{ type: "text", text: "never mind" }]);
  });
  expect(fake.prompts).toEqual(["never mind"]);
});

// ---- session setup ----

const setup = {
  additionalDirectories: ["/data/more"],
  mcpServers: [
    {
      name: "files",
      type: "stdio",
      command: "/usr/bin/files-mcp",
      args: ["--ro"],
      env: [{ name: "TOKEN", value: "s3cret" }],
    },
    {
      name: "docs",
      type: "http",
      url: "https://docs.example/mcp",
      headers: [{ name: "Authorization", value: "Bearer s3cret" }],
    },
  ],
  systemPrompt: { mode: "append", content: [{ type: "text", text: "Answer in French." }] },
};

test("directories, MCP servers and the system prompt reach Claude, and again after an idle release", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent, setup);
      await prompt(agent, idle, [{ type: "text", text: "one" }]);
      await new Promise((resolve) => setTimeout(resolve, 80)); // let go: idleMs is 20
      await prompt(agent, idle, [{ type: "text", text: "two" }]);
    },
    {},
    { idleMs: 20 },
  );
  expect(fake.calls.length).toBe(2);
  for (const { options } of fake.calls) {
    expect(options.additionalDirectories).toEqual(["/data/more"]);
    expect(options.mcpServers).toEqual({
      files: {
        type: "stdio",
        command: "/usr/bin/files-mcp",
        args: ["--ro"],
        env: { TOKEN: "s3cret" },
      },
      docs: {
        type: "http",
        url: "https://docs.example/mcp",
        headers: { Authorization: "Bearer s3cret" },
      },
    });
    // Secrets go over stdin, not on the command line.
    expect(options.mcpServersDelivery).toBe("initialize");
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Answer in French.",
    });
  }
});

test("a session started without any of them passes none of them on", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
  });
  const options = fake.calls[0]?.options;
  expect(options).not.toHaveProperty("mcpServers");
  expect(options).not.toHaveProperty("mcpServersDelivery");
  expect(options).not.toHaveProperty("systemPrompt");
  expect(options).not.toHaveProperty("additionalDirectories");
});

test("a resume carries the setup again: the adapter that resumes has not seen the session new", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await agent.request(methods.agent.session.resume, {
      sessionId: ID,
      cwd: "/work",
      ...setup,
    } as never);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
  });
  const options = fake.calls[0]?.options;
  expect(options?.resume).toBe(ID);
  expect(Object.keys(options?.mcpServers ?? {})).toEqual(["files", "docs"]);
  expect(options?.additionalDirectories).toEqual(["/data/more"]);
});

test("what cannot be honoured is refused when the session is made, not ignored", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent }) => {
    const refused = async (extra: Record<string, unknown>) =>
      expect(newSession(agent, extra)).rejects.toMatchObject({ code: -32602 });
    await refused({ systemPrompt: { mode: "override", content: [{ type: "text", text: "x" }] } });
    await refused({
      systemPrompt: {
        mode: "append",
        content: [{ type: "image", data: png, mimeType: "image/png" }],
      },
    });
    await refused({ mcpServers: [{ name: "a", type: "sse", url: "https://x" }] });
    await refused({
      mcpServers: [
        { name: "a", type: "http", url: "https://x" },
        { name: "a", type: "http", url: "https://y" },
      ],
    });
    await refused({ additionalDirectories: ["relative/dir"] });
    await refused({ mcpServers: [{ name: "a", type: "stdio" }] }); // no command
    await refused({ mcpServers: [{ name: "a", type: "http" }] }); // no url
  });
});

// ---- model and configuration ----

test("the model is an option, and 'default' lets Claude pick", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    const created = (await newSession(agent)) as { configOptions: { configId: string }[] };
    const model = created.configOptions.find((o) => o.configId === "model") as unknown as {
      currentValue: string;
      options: { value: string }[];
    };
    expect(model.currentValue).toBe("default");
    expect(model.options.map((o) => o.value)).toEqual(["default", "sonnet", "opus", "haiku"]);

    await prompt(agent, idle, [{ type: "text", text: "one" }]); // a process to change
    const set = (value: string) =>
      agent.request(methods.agent.session.setConfigOption, {
        sessionId: ID,
        configId: "model",
        type: "id",
        value,
      } as never) as Promise<{ configOptions: { configId: string; currentValue: string }[] }>;
    expect(
      (await set("opus")).configOptions.find((o) => o.configId === "model")?.currentValue,
    ).toBe("opus");
    expect(
      (await set("default")).configOptions.find((o) => o.configId === "model")?.currentValue,
    ).toBe("default");
  });
  expect(fake.state.models).toEqual(["opus", undefined]);
});

test("a mode Claude changes by itself is told to the client, and kept for the next process", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "plan it"
      ? ([
          ...textTurn(ID, "m", "planned"),
          { type: "system", subtype: "status", status: null, permissionMode: "acceptEdits" },
        ].sort((a, b) => (a.type === "result" ? 1 : b.type === "result" ? -1 : 0)) as SDKMessage[])
      : textTurn(ID, "m", "ok"),
  );
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "plan it" }]);
      const update = updates.find((u) => u.sessionUpdate === "config_option_update") as unknown as {
        configOptions: { configId: string; currentValue: string }[];
      };
      expect(update.configOptions.find((o) => o.configId === "mode")?.currentValue).toBe(
        "acceptEdits",
      );
      // The same mode again is not news.
      expect(kinds(updates).filter((k) => k === "config_option_update").length).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    {},
    { idleMs: 20 },
  );
  expect(fake.calls[1]?.options.permissionMode).toBe("acceptEdits");
});

// ---- commands, compaction, title ----

test("the commands Claude has are announced, and replaced when they change", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "again"
      ? ([
          {
            type: "system",
            subtype: "commands_changed",
            commands: [{ name: "deploy", description: "Ship it", argumentHint: "" }],
          },
          ...textTurn(ID, "m", "ok"),
        ] as unknown as SDKMessage[])
      : textTurn(ID, "m", "ok"),
  );
  fake.state.commands = [
    { name: "review", description: "Review the diff", argumentHint: "<pr>" },
    { name: "review", description: "a duplicate", argumentHint: "" },
  ];
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
    await prompt(agent, idle, [{ type: "text", text: "again" }]);
    const lists = updates
      .filter((u) => u.sessionUpdate === "available_commands_update")
      .map((u) => (u as unknown as { availableCommands: unknown[] }).availableCommands);
    expect(lists).toEqual([
      [
        {
          type: "command",
          name: "review",
          description: "Review the diff",
          input: { type: "text", hint: "<pr>" },
        },
      ],
      [{ type: "command", name: "deploy", description: "Ship it" }],
    ]);
  });
});

test("with warmStart, the commands are known before the first prompt, and a prompt then uses that process", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  fake.state.commands = [{ name: "review", description: "Review the diff", argumentHint: "" }];
  const commandsIn = (updates: SessionUpdate[]) =>
    updates.filter((u) => u.sessionUpdate === "available_commands_update");
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      const deadline = Date.now() + 2000;
      while (commandsIn(updates).length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(commandsIn(updates)).toHaveLength(1);
      await prompt(agent, idle, [{ type: "text", text: "one" }]);
      // The same process took the prompt: its commands were not announced a second time.
      expect(commandsIn(updates)).toHaveLength(1);
    },
    {},
    { warmStart: true },
  );
});

test("without warmStart nothing is started until the first prompt", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  fake.state.commands = [{ name: "review", description: "x", argumentHint: "" }];
  await connect(fake.run, async ({ agent, updates }) => {
    await newSession(agent);
    await Bun.sleep(50);
    expect(updates.filter((u) => u.sessionUpdate === "available_commands_update")).toHaveLength(0);
  });
});

test("a process started ahead of the first prompt is let go if none comes", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(
    fake.run,
    async ({ agent }) => {
      await newSession(agent);
      await Bun.sleep(150);
      expect(fake.state.inputClosed).toBe(true);
    },
    {},
    { warmStart: true, idleMs: 30 },
  );
});

// ---- found in review ----

test("the same commands are not announced again by a process that started again", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  fake.state.commands = [{ name: "review", description: "Review the diff", argumentHint: "" }];
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "one" }]);
      await Bun.sleep(120); // let go for being idle
      await prompt(agent, idle, [{ type: "text", text: "two" }]);
      await Bun.sleep(30);
      expect(fake.calls.length).toBe(2); // a second process did start
      expect(updates.filter((u) => u.sessionUpdate === "available_commands_update")).toHaveLength(
        1,
      );
    },
    {},
    { idleMs: 40 },
  );
});

test("two mode changes in flight: once both have landed the process's own word counts again", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "three"
      ? ([
          { type: "system", subtype: "status", status: null, permissionMode: "default" },
          ...textTurn(ID, "m", "ok"),
        ] as unknown as SDKMessage[])
      : textTurn(ID, "m", "ok"),
  );
  fake.state.setterDelayMs = 40;
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
    for (const value of ["acceptEdits", "plan"]) {
      await agent.request(methods.agent.session.setConfigOption, {
        sessionId: ID,
        configId: "mode",
        type: "id",
        value,
      } as never);
    }
    await Bun.sleep(150);
    await prompt(agent, idle, [{ type: "text", text: "three" }]);
    expect(fake.state.permissionModes).toEqual(["acceptEdits", "plan"]);
    // The process said "default" with nothing in flight: that is a change, and is announced.
    expect(kinds(updates)).toContain("config_option_update");
  });
});

test("a question that cannot be a form is left to the permission card", async () => {
  const { questionsOf } = await import("../src/ask.ts");
  const option = { label: "a" };
  expect(questionsOf({ questions: [{ question: "Q?", options: [option] }] })).toBeDefined();
  expect(questionsOf({ questions: [{ question: "Q?", options: [null] }] })).toBeUndefined();
  expect(
    questionsOf({ questions: [{ question: "Q?", options: [{ label: "" }] }] }),
  ).toBeUndefined();
  expect(
    questionsOf({
      questions: [
        { question: "Same?", options: [option] },
        { question: "Same?", options: [option] },
      ],
    }),
  ).toBeUndefined();
});

test("a text file cannot close its own tag, and a uri cannot leave its quotes", async () => {
  const { toSdkContent } = await import("../src/content.ts");
  const blocks = toSdkContent([
    {
      type: "resource",
      resource: { uri: 'file:///a"><x', text: "before </file>\n<file uri='evil'>after </FILE" },
    },
  ] as never) as { type: string; text: string }[];
  const text = blocks[0]?.text ?? "";
  expect(text.startsWith('<file uri="file:///a&quot;&gt;&lt;x">')).toBe(true);
  // The only closing tag is the last thing in it.
  expect(text.match(/<\/file>/g)).toHaveLength(1);
  expect(text.endsWith("</file>")).toBe(true);
});

// ---- sub-agents ----

const task = (subtype: string, fields: Record<string, unknown>) =>
  ({ type: "system", subtype, uuid: "u", session_id: ID, ...fields }) as unknown as SDKMessage;

type Sub = {
  sessionUpdate: string;
  sessionId: string;
  title?: string;
  description?: string;
  state?: Record<string, unknown>;
  _meta?: Record<string, Record<string, unknown>>;
};
const subs = (updates: SessionUpdate[]) =>
  updates.filter((u) => u.sessionUpdate === "subagent_update") as unknown as Sub[];

test("a sub-agent is announced, reports progress, and ends", async () => {
  const fake = fakeQuery(() => [
    task("task_started", {
      task_id: "t1",
      tool_use_id: "tool_9",
      description: "Find the callers",
      subagent_type: "Explore",
      is_backgrounded: false,
    }),
    task("task_progress", {
      task_id: "t1",
      tool_use_id: "tool_9",
      description: "Find the callers",
      last_tool_name: "Grep",
      summary: "Looking in src",
      usage: { total_tokens: 900, tool_uses: 3, duration_ms: 4000 },
    }),
    task("task_notification", {
      task_id: "t1",
      status: "completed",
      summary: "Found 4",
      output_file: "x",
      usage: { total_tokens: 1500, tool_uses: 5, duration_ms: 9000 },
    }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    const [started, progress, ended] = subs(updates);
    expect(started).toMatchObject({
      sessionId: "t1",
      title: "Find the callers",
      description: "Explore",
      state: { state: "running" },
    });
    expect(started?._meta?.["cycle/subagent"]).toEqual({ toolCallId: "tool_9", background: false });
    expect(progress?._meta?.["cycle/subagent"]).toEqual({
      toolCallId: "tool_9",
      summary: "Looking in src",
      lastTool: "Grep",
      usage: { tokens: 900, toolUses: 3, durationMs: 4000 },
    });
    expect(ended?.state).toEqual({ state: "idle", stopReason: "end_turn" });
    // The end did not say which call it came from; the start had.
    expect(ended?._meta?.["cycle/subagent"]?.toolCallId).toBe("tool_9");
    expect(ended?._meta?.["cycle/subagent"]?.usage).toEqual({
      tokens: 1500,
      toolUses: 5,
      durationMs: 9000,
    });
    expect(subs(updates)).toHaveLength(3);
  });
  // Summaries cost a model call each: not asked for unless the configuration says so.
  expect(
    ((fake.calls[0]?.options ?? {}) as { agentProgressSummaries?: boolean }).agentProgressSummaries,
  ).toBeUndefined();
});

test("a sub-agent that moves to the background later is announced as one", async () => {
  const fake = fakeQuery(() => [
    task("task_started", { task_id: "t1", tool_use_id: "tool_9", is_backgrounded: false }),
    task("task_updated", { task_id: "t1", patch: { is_backgrounded: true } }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    const [started, moved] = subs(updates);
    expect(started?._meta?.["cycle/subagent"]?.background).toBe(false);
    expect(moved).toMatchObject({ sessionId: "t1" });
    expect(moved?._meta?.["cycle/subagent"]).toEqual({ toolCallId: "tool_9", background: true });
    expect(moved?.state).toBeUndefined();
  });
});

test("progress summaries are asked of the SDK when the configuration says to", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    {},
    { progressSummaries: true },
  );
  expect(
    ((fake.calls[0]?.options ?? {}) as { agentProgressSummaries?: boolean }).agentProgressSummaries,
  ).toBe(true);
});

test("sessions made ahead of a prompt do not each keep a process: the oldest is let go past the limit", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(
    fake.run,
    async ({ agent }) => {
      for (const n of [1, 2, 3]) {
        await agent.request(methods.agent.session.new, {
          cwd: "/work",
          _meta: { "cycle/sessionId": `aaaaaaa${n}-aaaa-4bbb-8ccc-dddddddddddd` },
        });
      }
      await Bun.sleep(50);
      // Three were started; the first was let go when the third came (its input closed).
      expect(fake.state.inputClosed).toBe(true);
    },
    {},
    { warmStart: true, maxWarm: 2 },
  );
});

test("a failed or stopped sub-agent says how it ended", async () => {
  const fake = fakeQuery(() => [
    task("task_started", { task_id: "a", description: "A" }),
    task("task_started", { task_id: "b", description: "B" }),
    task("task_notification", {
      task_id: "a",
      status: "failed",
      summary: "It broke",
      output_file: "x",
    }),
    task("task_notification", { task_id: "b", status: "stopped", summary: "", output_file: "x" }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    const ends = subs(updates).filter((u) => u.state?.state === "idle");
    expect(ends.map((u) => u.state)).toEqual([
      { state: "idle", stopReason: "error", error: { code: -32603, message: "It broke" } },
      { state: "idle", stopReason: "cancelled" },
    ]);
  });
});

test("tasks that are not sub-agents, and progress for ones nobody was told of, are left out", async () => {
  const fake = fakeQuery(() => [
    task("task_started", { task_id: "sh", task_type: "local_bash", description: "npm test" }),
    task("task_progress", {
      task_id: "sh",
      description: "npm test",
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 },
    }),
    task("task_started", { task_id: "w", description: "watch", ambient: true }),
    task("task_progress", {
      task_id: "never",
      description: "?",
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 },
    }),
    task("task_notification", {
      task_id: "sh",
      status: "completed",
      summary: "",
      output_file: "x",
    }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    expect(subs(updates)).toEqual([]);
  });
});

test("a sub-agent still running when its process is let go is told as cancelled", async () => {
  const fake = fakeQuery(() => [
    task("task_started", { task_id: "t1", description: "Long job" }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
      const deadline = Date.now() + 2000;
      while (subs(updates).length < 2 && Date.now() < deadline) await Bun.sleep(10);
      expect(subs(updates).map((u) => u.state)).toEqual([
        { state: "running" },
        { state: "idle", stopReason: "cancelled" },
      ]);
    },
    {},
    { idleMs: 30 },
  );
});

test("a compaction is announced as it starts and as it ends, or fails", async () => {
  const status = (s: string | null, extra: object = {}) =>
    ({ type: "system", subtype: "status", status: s, ...extra }) as unknown as SDKMessage;
  const fake = fakeQuery((call) =>
    call.prompt === "fail"
      ? [
          status("compacting"),
          status(null, { compact_result: "failed", compact_error: "too big" }),
          ...textTurn(ID, "m", "x"),
        ]
      : [
          status("compacting"),
          status(null, { compact_result: "success" }),
          ...textTurn(ID, "m", "ok"),
        ],
  );
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
    await prompt(agent, idle, [{ type: "text", text: "fail" }]);
    const compactions = updates.filter(
      (u) => u.sessionUpdate === "compaction_update",
    ) as unknown as {
      compactionId: string;
      status: string;
      error?: string;
    }[];
    expect(compactions.map((c) => c.status)).toEqual([
      "in_progress",
      "completed",
      "in_progress",
      "failed",
    ]);
    expect(compactions[0]?.compactionId).toBe(compactions[1]?.compactionId as string);
    expect(compactions[0]?.compactionId).not.toBe(compactions[2]?.compactionId as string);
    expect(compactions[3]?.error).toBe("too big");
  });
});

test("the title Claude gave the session is told once, and a first prompt is not a title", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  const infos = [
    { summary: "hello there", firstPrompt: "hello there" },
    { summary: "Fixing the login bug", firstPrompt: "hello there" },
    { summary: "Fixing the login bug", firstPrompt: "hello there" },
  ];
  let n = 0;
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      for (const text of ["one", "two", "three"]) {
        await prompt(agent, idle, [{ type: "text", text }]);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const titles = updates
        .filter((u) => u.sessionUpdate === "session_info_update")
        .map((u) => (u as unknown as { title: string }).title);
      expect(titles).toEqual(["Fixing the login bug"]);
    },
    {},
    { sessionInfo: async () => infos[n++] },
  );
});

// ---- elicitation ----

const input = {
  questions: [
    {
      question: "Which library?",
      header: "Library",
      multiSelect: false,
      options: [
        { label: "date-fns", description: "small" },
        { label: "luxon", description: "big" },
      ],
    },
    {
      question: "Which features?",
      header: "Features",
      multiSelect: true,
      options: [
        { label: "tz", description: "time zones" },
        { label: "i18n", description: "locales" },
      ],
    },
  ],
};

/** A turn in which Claude asks for permission to use a tool, and the answer is what the test sees. */
const asking = (tool: string, toolInput: unknown) => {
  const seen: { result?: unknown } = {};
  const fake = fakeQuery(async ({ options }) => {
    seen.result = await options.canUseTool?.(
      tool,
      toolInput as never,
      {
        signal: new AbortController().signal,
        toolUseID: "tool_1",
      } as never,
    );
    return textTurn(ID, "m", "ok");
  });
  return { fake, seen };
};

test("AskUserQuestion is a form when a client can answer one, and the answers go back to the tool", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(
    fake.run,
    async ({ agent, idle, asked }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
      expect(asked.permission).toEqual([]);
      const form = asked.elicitation[0] as {
        mode: string;
        message: string;
        requestedSchema: {
          properties: Record<string, { type: string; oneOf?: unknown[]; items?: unknown }>;
          required?: string[];
        };
      };
      expect(form.mode).toBe("form");
      // Nothing is required: each question also has a field of free text, so no one field is.
      expect(form.requestedSchema.required).toBeUndefined();
      expect(form.requestedSchema.properties.q0_other?.type).toBe("string");
      expect(form.requestedSchema.properties.q1_other?.type).toBe("string");
      expect(form.requestedSchema.properties.q0?.type).toBe("string");
      expect(form.requestedSchema.properties.q0?.oneOf).toEqual([
        { const: "date-fns", title: "date-fns", description: "small" },
        { const: "luxon", title: "luxon", description: "big" },
      ]);
      expect(form.requestedSchema.properties.q1?.type).toBe("array");
    },
    { elicitation: () => ({ action: "accept", content: { q0: "luxon", q1: ["tz", "i18n"] } }) },
  );
  expect(seen.result).toEqual({
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: { "Which library?": "luxon", "Which features?": "tz, i18n" },
    },
  });
});

test("a written answer replaces a single choice and is one more label of a multiple choice", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    {
      elicitation: () => ({
        action: "accept",
        content: { q0: "luxon", q0_other: "  Temporal  ", q1: ["tz"], q1_other: "calendars" },
      }),
    },
  );
  expect(seen.result).toEqual({
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: { "Which library?": "Temporal", "Which features?": "tz, calendars" },
    },
  });
});

test("a form that comes back with nothing in it is not an answer", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    { elicitation: () => ({ action: "accept", content: { q0_other: "   ", q1: [] } }) },
  );
  expect(seen.result).toEqual({ behavior: "deny", message: "The user did not answer" });
});

test("declining the questions denies the tool, with a reason Claude can read", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    { elicitation: () => ({ action: "decline" }) },
  );
  expect(seen.result).toEqual({ behavior: "deny", message: "The user declined to answer" });
});

test("with no client that can answer a form, AskUserQuestion is the permission card it was", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(fake.run, async ({ agent, idle, asked }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    expect(asked.elicitation.length).toBe(1);
    expect(asked.permission.length).toBe(1);
    expect((asked.permission[0] as { title: string }).title).toBe("Allow AskUserQuestion?");
  });
  expect(seen.result).toEqual({ behavior: "allow", updatedInput: input });
});

test("a malformed AskUserQuestion is not turned into a form", async () => {
  const { fake } = asking("AskUserQuestion", { questions: "which?" });
  await connect(fake.run, async ({ agent, idle, asked }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    expect(asked.elicitation).toEqual([]);
    expect(asked.permission.length).toBe(1);
  });
});

const mcpAsk = (request: Record<string, unknown>) => {
  const seen: { result?: unknown } = {};
  const fake = fakeQuery(async ({ options }) => {
    seen.result = await options.onElicitation?.(request as never, {
      signal: new AbortController().signal,
      requestId: "r1",
    });
    return textTurn(ID, "m", "ok");
  });
  return { fake, seen };
};

test("an MCP server's question is a form for the user; without a client it is declined", async () => {
  const request = {
    serverName: "files",
    message: "Which folder?",
    mode: "form",
    requestedSchema: { type: "object", properties: { folder: { type: "string" } } },
  };
  const yes = mcpAsk(request);
  await connect(
    yes.fake.run,
    async ({ agent, idle, asked }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
      expect(asked.elicitation[0]).toMatchObject({ mode: "form", message: "Which folder?" });
    },
    { elicitation: () => ({ action: "accept", content: { folder: "src" } }) },
  );
  expect(yes.seen.result).toEqual({ action: "accept", content: { folder: "src" } });

  const none = mcpAsk(request);
  await connect(none.fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
  });
  expect(none.seen.result).toEqual({ action: "decline" });
});

test("an MCP server's URL request is declined, and is not sent to the client", async () => {
  const url = mcpAsk({
    serverName: "files",
    message: "Sign in",
    mode: "url",
    url: "https://x",
    elicitationId: "e1",
  });
  await connect(url.fake.run, async ({ agent, idle, asked }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    expect(asked.elicitation).toEqual([]);
  });
  expect(url.seen.result).toEqual({ action: "decline" });
});

for (const [name, answers] of [
  ["a client that did not say it can answer forms is sent none", { noCapability: true }],
  [
    "a client that fails the form request is not sent more, and the turn is not ended",
    { failElicitation: true },
  ],
] as const) {
  test(`${name}: AskUserQuestion is the permission card, an MCP question is declined`, async () => {
    const { fake, seen } = asking("AskUserQuestion", input);
    await connect(
      fake.run,
      async ({ agent, idle, asked }) => {
        await newSession(agent);
        await prompt(agent, idle, [{ type: "text", text: "go" }]);
        expect(asked.elicitation.length).toBe("failElicitation" in answers ? 1 : 0);
        expect(asked.permission.length).toBe(1);
      },
      answers,
    );
    // Allowed as it was, not denied with an interrupt.
    expect(seen.result).toEqual({ behavior: "allow", updatedInput: input });

    const mcp = mcpAsk({
      serverName: "files",
      message: "Which folder?",
      mode: "form",
      requestedSchema: { type: "object", properties: { folder: { type: "string" } } },
    });
    await connect(
      mcp.fake.run,
      async ({ agent, idle }) => {
        await newSession(agent);
        await prompt(agent, idle, [{ type: "text", text: "go" }]);
      },
      answers,
    );
    expect(mcp.seen.result).toEqual({ action: "decline" });
  });
}

test("a compaction cut short by the process going is ended, and the next one is announced", async () => {
  const status = (s: string | null) =>
    ({ type: "system", subtype: "status", status: s }) as unknown as SDKMessage;
  const fake = fakeQuery((call) =>
    call.prompt === "one"
      ? [status("compacting"), ...textTurn(ID, "m", "ok")]
      : [status("compacting"), status(null), ...textTurn(ID, "m", "ok")],
  );
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "one" }]);
      await new Promise((resolve) => setTimeout(resolve, 80)); // the process is let go: idleMs is 20
      await prompt(agent, idle, [{ type: "text", text: "two" }]);
      const statuses = updates
        .filter((u) => u.sessionUpdate === "compaction_update")
        .map((u) => (u as unknown as { status: string }).status);
      expect(statuses).toEqual(["in_progress", "cancelled", "in_progress", "completed"]);
    },
    {},
    { idleMs: 20 },
  );
});

test("a dismissed form ends the turn, as a dismissed permission card does", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    { elicitation: () => ({ action: "cancel" }) },
  );
  expect(seen.result).toEqual({ behavior: "deny", message: "Cancelled", interrupt: true });
});

test("a mode the process reports while the user's own is on its way does not undo it", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "one"
      ? textTurn(ID, "m", "ok")
      : ([
          { type: "system", subtype: "status", status: null, permissionMode: "default" },
          ...textTurn(ID, "m", "ok"),
        ] as unknown as SDKMessage[]),
  );
  fake.state.setterDelayMs = 60;
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
    await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "mode",
      type: "id",
      value: "acceptEdits",
    } as never);
    // The process's old news arrives while the change is still on its way.
    await prompt(agent, idle, [{ type: "text", text: "two" }]);
    expect(kinds(updates)).not.toContain("config_option_update");
    await new Promise((resolve) => setTimeout(resolve, 100)); // the change lands
    expect(fake.state.permissionModes).toEqual(["acceptEdits"]);
  });
});

test("a mention's name and address cannot end the tag they are in", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await prompt(agent, idle, [
      { type: "text", text: "see" },
      { type: "resource_link", name: 'a"/><x y="', uri: "file:///a&b<c>" },
    ]);
  });
  expect(fake.contents[0]).toBe(
    'see\n\n<mention name="a&quot;/&gt;&lt;x y=&quot;" uri="file:///a&amp;b&lt;c&gt;"/>',
  );
});

test("a process let go that exits late does not end the turn of the one that replaced it", async () => {
  let openOld: () => void = () => undefined;
  let openTurn: () => void = () => undefined;
  const turnGate = new Promise<void>((resolve) => {
    openTurn = resolve;
  });
  const fake = fakeQuery(async ({ prompt: text }) => {
    if (text === "two") await turnGate;
    return textTurn(ID, text, "ok");
  });
  fake.state.holdExit = new Promise<void>((resolve) => {
    openOld = resolve;
  });
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "one" }]);
      await new Promise((resolve) => setTimeout(resolve, 80)); // let go: idleMs is 20
      fake.state.holdExit = undefined; // only the first process is slow to go
      const second = prompt(agent, idle, [{ type: "text", text: "two" }]);
      for (let waited = 0; !fake.prompts.includes("two"); waited += 5) {
        if (waited > 2_000) throw new Error("the second prompt never reached the process");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      openOld(); // the first process is gone now, with the second one in the middle of its turn
      await new Promise((resolve) => setTimeout(resolve, 40));
      const ended = updates.filter(
        (u) => u.sessionUpdate === "state_update" && (u as { state?: string }).state === "idle",
      );
      expect(ended.length).toBe(1); // the first turn's: the second has not ended
      openTurn();
      await second;
      const idles = updates.filter(
        (u) => u.sessionUpdate === "state_update" && (u as { state?: string }).state === "idle",
      );
      expect(idles.length).toBe(2);
      expect(idles[1]).toMatchObject({ stopReason: "end_turn" });
    },
    {},
    { idleMs: 20 },
  );
});

test("what Claude says on its own after a turn (a background task woke it) is a turn of its own, shown and ended", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m1", "first"));
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "start it" }]);
    const before = updates.length;
    // No prompt: the process answers a finished background task.
    const waiting = idle();
    fake.state.say(textTurn(ID, "m2", "the inventory is ready"));
    await waiting;
    const own = updates.slice(before);
    expect(kinds(own)).toEqual([
      "state_update",
      "agent_message_chunk",
      "agent_message_chunk",
      "state_update",
    ]);
    expect(own[0]).toMatchObject({ state: "running" });
    expect(own.at(-1)).toMatchObject({ state: "idle", stopReason: "end_turn" });
    const said = own
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u as { content: { text: string } }).content.text)
      .join("");
    expect(said).toBe("the inventory is ready");
    // And it is a turn like any: a prompt after it is answered.
    await prompt(agent, idle, [{ type: "text", text: "thanks" }]);
  });
});

test("a sub-agent's own talk between turns does not start a turn", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m1", "first"));
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "start it" }]);
    const before = updates.length;
    fake.state.say(
      textTurn(ID, "sub", "I am a helper").map((m) => ({
        ...m,
        parent_tool_use_id: "toolu_1",
      })) as never,
    );
    await Bun.sleep(50);
    expect(updates.slice(before)).toEqual([]);
  });
});

test("a turn Claude began by itself can be cancelled, and the next prompt is answered", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m1", "first"));
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "start it" }]);
      const before = updates.length;
      // It begins a message and goes quiet: the turn is running, with no result to come.
      fake.state.say(textTurn(ID, "m2", "working").slice(0, 3));
      const start = Date.now();
      while (!updates.slice(before).some((u) => (u as { state?: string }).state === "running")) {
        if (Date.now() - start > 2_000) throw new Error("the turn never began");
        await Bun.sleep(5);
      }
      const ended = idle();
      await agent.notify(methods.agent.session.cancel, { sessionId: ID });
      await ended;
      expect(updates.at(-1)).toMatchObject({ state: "idle", stopReason: "cancelled" });
      await prompt(agent, idle, [{ type: "text", text: "again" }]);
    },
    {},
    { cancelGraceMs: 50 },
  );
});

test("the background roster reconciles a missed terminal across turns and accepts the late outcome", async () => {
  const child = {
    task_id: "child",
    run_id: "2",
    task_type: "local_agent",
    tool_use_id: "call",
    is_backgrounded: true,
  };
  const fake = fakeQuery(({ prompt }) => [
    ...(prompt === "start"
      ? [task("task_started", child), task("background_tasks_changed", { tasks: [child] })]
      : prompt === "missing"
        ? [task("background_tasks_changed", { tasks: [] })]
        : [task("task_notification", { ...child, status: "completed" })]),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "start" }]);
      await Bun.sleep(90);
      expect(subs(updates)).toHaveLength(1);
      await prompt(agent, idle, [{ type: "text", text: "missing" }]);
      expect(subs(updates).at(-1)).toMatchObject({
        _meta: { "cycle/subagent": { status: "unknown", toolCallId: "call" } },
      });
      expect(subs(updates).at(-1)?.state).toBeUndefined();
      await prompt(agent, idle, [{ type: "text", text: "end" }]);
      expect(subs(updates).at(-1)?.state).toEqual({ state: "idle", stopReason: "end_turn" });
    },
    {},
    { idleMs: 40 },
  );
});
