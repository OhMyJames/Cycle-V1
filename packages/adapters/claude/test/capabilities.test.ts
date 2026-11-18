import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { client, methods, RequestError, type SessionUpdate } from "@cycle/acp";
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
    { type: "text", text: "[log](file:///var/log/x)" },
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
  expect(fake.contents[0]).toBe("see\n\n[a](file:///a)");
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
          required: string[];
        };
      };
      expect(form.mode).toBe("form");
      expect(form.requestedSchema.required).toEqual(["q0", "q1"]);
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
