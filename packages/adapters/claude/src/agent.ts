import { randomUUID } from "node:crypto";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentContext,
  agent as acpAgent,
  type ContentBlock,
  methods,
  RequestError,
  type SessionConfigOption,
  type SessionUpdate,
} from "@cycle/acp";
import { type StopReason, stopReasonOf, TurnTranslator, toolKind } from "./translate.ts";

export type QueryFn = (params: { prompt: string; options: Options }) => Query;

export type AdapterConfig = {
  /**
   * Everything the Claude process may see. Nothing is inherited from this process: the daemon
   * decides, from its allowlist, and passes it in (decision 0001).
   */
  env: Record<string, string>;
  /** The SDK's own binary is used when this is absent. */
  claudeExecutable?: string;
};

const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;
type PermissionMode = (typeof PERMISSION_MODES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key the daemon uses to propose the agent's own session id (docs/protocol.md §6). */
const PROPOSED_ID = "cycle/sessionId";

type Turn = {
  abort: AbortController;
  query: Query | undefined;
  cancelled: boolean;
};

type SessionState = {
  id: string;
  cwd: string;
  /** False until the first turn has begun: then the id exists on disk and is resumed, not created. */
  started: boolean;
  mode: PermissionMode;
  model: string | undefined;
  turn: Turn | undefined;
};

const textOf = (blocks: ContentBlock[]): string =>
  blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n\n");

const configOptions = (session: SessionState): SessionConfigOption[] =>
  [
    {
      configId: "mode",
      name: "Permission mode",
      type: "select",
      currentValue: session.mode,
      options: [
        { value: "default", name: "Ask before editing or running" },
        { value: "acceptEdits", name: "Accept file edits" },
        { value: "plan", name: "Plan only" },
      ],
    },
  ] as SessionConfigOption[];

/**
 * An ACP v2 agent over the Claude Agent SDK. One Claude process lives for one turn: the first turn
 * creates the session under the id the daemon proposed, later ones resume it. That costs a start
 * per turn; a long-lived query fed by a stream is the next step, once the mapping is proven.
 */
export const createAgent = (config: AdapterConfig, runQuery: QueryFn) => {
  const sessions = new Map<string, SessionState>();

  const notify = (client: AgentContext, sessionId: string, update: SessionUpdate) =>
    client.notify(methods.client.session.update, { sessionId, update });

  const require = (sessionId: string): SessionState => {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw new RequestError(-32002, "Session not found", { sessionId });
    }
    return session;
  };

  const runTurn = async (
    client: AgentContext,
    session: SessionState,
    turn: Turn,
    prompt: string,
  ) => {
    const translator = new TurnTranslator();
    let stop: StopReason = { stopReason: "end_turn" };
    try {
      // A cancel can arrive before the query starts: then there is nothing to interrupt.
      if (turn.cancelled) throw new Error("cancelled before it started");
      const options: Options = {
        cwd: session.cwd,
        env: config.env,
        abortController: turn.abort,
        includePartialMessages: true,
        permissionMode: session.mode,
        ...(session.model !== undefined ? { model: session.model } : {}),
        ...(config.claudeExecutable !== undefined
          ? { pathToClaudeCodeExecutable: config.claudeExecutable }
          : {}),
        ...(session.started ? { resume: session.id } : { sessionId: session.id }),
        canUseTool: async (toolName, input, context) => {
          const outcome = await client.request(
            methods.client.session.requestPermission,
            {
              sessionId: session.id,
              title: `Allow ${toolName}?`,
              subject: {
                type: "tool_call",
                toolCall: {
                  toolCallId: context.toolUseID,
                  name: toolName,
                  kind: toolKind(toolName),
                  rawInput: input,
                },
              },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            } as never,
            { signal: context.signal } as never,
          );
          const decision = (outcome as { outcome: { outcome: string; optionId?: string } }).outcome;
          if (decision.outcome === "selected" && decision.optionId === "allow") {
            return { behavior: "allow", updatedInput: input };
          }
          return {
            behavior: "deny",
            message: decision.outcome === "cancelled" ? "Cancelled" : "The user denied it",
            ...(decision.outcome === "cancelled" ? { interrupt: true } : {}),
          };
        },
      };
      const query = runQuery({ prompt, options });
      turn.query = query;
      for await (const message of query as AsyncIterable<SDKMessage>) {
        if (message.type === "system" && message.subtype === "init") session.started = true;
        for (const update of translator.feed(message)) await notify(client, session.id, update);
        if (message.type === "result") stop = stopReasonOf(message);
      }
    } catch (error) {
      stop = turn.cancelled
        ? { stopReason: "cancelled" }
        : {
            stopReason: "error",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          };
    } finally {
      session.turn = undefined;
    }
    if (turn.cancelled) stop = { stopReason: "cancelled" };
    await notify(client, session.id, {
      sessionUpdate: "state_update",
      state: "idle",
      ...stop,
    } as SessionUpdate);
  };

  return acpAgent({ name: "cycle-claude-adapter" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 2,
      info: { name: "cycle-claude-adapter", version: "0.0.0" },
      capabilities: { session: { prompt: {} } },
    }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      const proposed = (params._meta as Record<string, unknown> | null | undefined)?.[PROPOSED_ID];
      // Take the daemon's id when it is a UUID, which is all the SDK accepts; otherwise make one.
      const id = typeof proposed === "string" && UUID.test(proposed) ? proposed : randomUUID();
      const session: SessionState = {
        id,
        cwd: params.cwd,
        started: false,
        mode: "default",
        model: undefined,
        turn: undefined,
      };
      sessions.set(id, session);
      return { sessionId: id, configOptions: configOptions(session) };
    })
    .onRequest(methods.agent.session.resume, async ({ params, client }) => {
      if (params.replayFrom !== undefined && params.replayFrom !== null) {
        // The daemon keeps the history. Replaying it here would put every record in the log twice.
        throw new RequestError(-32602, "This agent does not replay history", {
          replayFrom: params.replayFrom,
        });
      }
      const session =
        sessions.get(params.sessionId) ??
        ({
          id: params.sessionId,
          cwd: params.cwd,
          // The id is on disk in the Claude config directory: resume it.
          started: true,
          mode: "default",
          model: undefined,
          turn: undefined,
        } satisfies SessionState);
      sessions.set(session.id, session);
      // ACP v2: a successful resume sends the current state before it answers.
      await notify(client, session.id, {
        sessionUpdate: "state_update",
        state: session.turn ? "running" : "idle",
      } as SessionUpdate);
      return { configOptions: configOptions(session) };
    })
    .onRequest(methods.agent.session.prompt, ({ params, client }) => {
      const session = require(params.sessionId);
      if (session.turn !== undefined) {
        throw new RequestError(-32600, "A turn is already running", { sessionId: session.id });
      }
      const messageId = randomUUID();
      // The turn exists from here, before anything is awaited: a cancel or a second prompt that
      // arrives while the first notifications are going out must find it.
      const turn: Turn = { abort: new AbortController(), query: undefined, cancelled: false };
      session.turn = turn;
      // The turn goes on after this answers: ACP v2 ends a turn with an idle state_update.
      void (async () => {
        try {
          await notify(client, session.id, {
            sessionUpdate: "user_message",
            messageId,
            content: params.prompt,
          } as SessionUpdate);
          await notify(client, session.id, {
            sessionUpdate: "state_update",
            state: "running",
          } as SessionUpdate);
          await runTurn(client, session, turn, textOf(params.prompt));
        } catch {
          // The connection is gone: there is no one to tell.
        } finally {
          if (session.turn === turn) session.turn = undefined;
        }
      })();
      return { messageId };
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      const turn = session?.turn;
      if (turn === undefined) return;
      turn.cancelled = true;
      await turn.query?.interrupt().catch(() => undefined);
      turn.abort.abort();
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      const session = require(params.sessionId);
      const value = "value" in params ? params.value : undefined;
      if (params.configId === "mode") {
        if (!PERMISSION_MODES.includes(value as PermissionMode)) {
          throw new RequestError(-32602, "Unknown permission mode", { value });
        }
        session.mode = value as PermissionMode;
      } else if (params.configId === "model" && typeof value === "string") {
        session.model = value;
      } else {
        throw new RequestError(-32602, "Unknown configuration option", {
          configId: params.configId,
        });
      }
      return { configOptions: configOptions(session) };
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (session?.turn) {
        session.turn.cancelled = true;
        session.turn.abort.abort();
      }
      sessions.delete(params.sessionId);
      return {};
    });
};
