import { randomUUID } from "node:crypto";
import { type AgentConnection, agent, methods, type SessionUpdate } from "@cycle/acp";
import type { AgentDefinition } from "../src/index.ts";

type Script = {
  /** Called when a prompt arrives: what the agent does with it. */
  onPrompt?: (ctx: Turn) => Promise<unknown>;
};

export type Turn = {
  prompt: string;
  /** The blocks of the prompt, as the agent got them. */
  blocks: unknown[];
  /** Asks the user for a form (`elicitation/create`); the answer is whatever the daemon says. */
  elicit: () => Promise<unknown>;
  say: (update: object) => Promise<void>;
  ask: () => Promise<unknown>;
  /** Resolves when a cancel has come in. */
  cancelled: Promise<void>;
};

/**
 * An ACP v2 agent in this process, which does what a test tells it to. It records how it was
 * called, and can be made to crash.
 */
export const fakeAgent = (
  script: Script = {},
  options: { promptCapabilities?: Record<string, unknown> } = {},
) => {
  const log = {
    news: [] as Record<string, unknown>[],
    resumes: [] as Record<string, unknown>[],
    prompts: [] as string[],
    blocks: [] as unknown[][],
    cancels: 0,
    launches: 0,
    configs: [] as Record<string, unknown>[],
  };
  const connections: AgentConnection[] = [];
  const cancelResolvers: (() => void)[] = [];

  const build = () => {
    const sessions = new Set<string>();
    const app = agent({ name: "fake" })
      .onConnect((connection) => {
        connections.push(connection);
      })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: 2,
        info: { name: "fake", version: "0" },
        capabilities: {},
      }))
      .onRequest(methods.agent.session.new, ({ params }) => {
        log.news.push(params as unknown as Record<string, unknown>);
        const proposed = (params._meta as Record<string, unknown> | null)?.["cycle/sessionId"];
        const id = typeof proposed === "string" ? proposed : randomUUID();
        sessions.add(id);
        return { sessionId: id, configOptions: [] };
      })
      .onRequest(methods.agent.session.resume, async ({ params, client }) => {
        log.resumes.push(params as unknown as Record<string, unknown>);
        sessions.add(params.sessionId);
        // ACP v2: the state, before the answer.
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "state_update", state: "idle" } as SessionUpdate,
        });
        return {};
      })
      .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        log.configs.push(params as unknown as Record<string, unknown>);
        return { configOptions: [] };
      })
      .onNotification(methods.agent.session.cancel, () => {
        log.cancels++;
        for (const resolve of cancelResolvers.splice(0)) resolve();
      })
      .onRequest(methods.agent.session.prompt, ({ params, client }) => {
        const sessionId = params.sessionId;
        const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
        log.prompts.push(text);
        log.blocks.push(params.prompt as unknown[]);
        const messageId = randomUUID();
        const say = (update: object) =>
          client.notify(methods.client.session.update, {
            sessionId,
            update: update as SessionUpdate,
          });
        const cancelled = new Promise<void>((resolve) => cancelResolvers.push(resolve));
        const elicit = () =>
          client.request(methods.client.elicitation.create, {
            sessionId,
            mode: "form",
            message: "Which one?",
            requestedSchema: { type: "object", properties: { pick: { type: "string" } } },
          } as never);
        const ask = () =>
          client.request(methods.client.session.requestPermission, {
            sessionId,
            title: "Allow it?",
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          } as never);
        void (async () => {
          await say({ sessionUpdate: "user_message", messageId, content: params.prompt });
          await say({ sessionUpdate: "state_update", state: "running" });
          let ended = false;
          if (script.onPrompt) {
            ended =
              (await script.onPrompt({
                prompt: text,
                blocks: params.prompt,
                say,
                ask,
                elicit,
                cancelled,
              })) === "ended";
          } else {
            await say({
              sessionUpdate: "agent_message_chunk",
              messageId: "a1",
              content: { type: "text", text: `echo: ${text}` },
            });
          }
          // A script that ended the turn itself (an error, say) is not given a second ending.
          if (!ended)
            await say({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
        })().catch(() => {});
        return { messageId };
      });
    return app;
  };

  const definition: AgentDefinition = {
    id: "fake",
    name: "Fake",
    configSchema: { type: "object", properties: { mode: { type: "string" } } },
    ...(options.promptCapabilities !== undefined
      ? { promptCapabilities: options.promptCapabilities }
      : {}),
    launch: async () => {
      log.launches++;
      return { target: build() };
    },
  };
  return { definition, log, crash: () => connections.at(-1)?.close() };
};
