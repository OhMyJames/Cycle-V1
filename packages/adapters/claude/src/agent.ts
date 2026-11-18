import { randomUUID } from "node:crypto";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentContext,
  agent as acpAgent,
  type ContentBlock,
  methods,
  RequestError,
  type SessionConfigOption,
  type SessionUpdate,
} from "@cycle/acp";
import { PlanState, type StopReason, stopReasonOf, TurnTranslator, toolKind } from "./translate.ts";

/** The SDK's `query`, in streaming-input mode: the prompt is a stream, so one process serves many turns. */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

export type AdapterConfig = {
  /**
   * Everything the Claude process may see. Nothing is inherited from this process: the daemon
   * decides, from its allowlist, and passes it in (decision 0001).
   */
  env: Record<string, string>;
  /** The SDK's own binary is used when this is absent. */
  claudeExecutable?: string;
  /**
   * How long a session's Claude process may sit idle before it is let go (ms). A process is about
   * 230 MB, and there is one per open session; the next prompt resumes the session. Default 5 minutes.
   */
  idleMs?: number;
  /** How long a cancelled turn may take to stop before its process is killed (ms). Default 3 seconds. */
  cancelGraceMs?: number;
};

const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;
type PermissionMode = (typeof PERMISSION_MODES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key the daemon uses to propose the agent's own session id (docs/protocol.md §6). */
const PROPOSED_ID = "cycle/sessionId";

type Turn = {
  translator: TurnTranslator;
  /** Aborted on cancel: it ends a permission request that is still waiting for an answer. */
  permissions: AbortController;
  cancelled: boolean;
  done: boolean;
  killTimer: ReturnType<typeof setTimeout> | undefined;
};

/** A Claude process, and the stream that feeds it. It lives for many turns. */
type Live = {
  query: Query;
  abort: AbortController;
  /** Hands the process a user message. */
  push: (text: string) => void;
  /** Ends the input: the process finishes what it is doing and exits. */
  end: () => void;
  idle: ReturnType<typeof setTimeout> | undefined;
};

type SessionState = {
  id: string;
  cwd: string;
  /** False until a process has started the session: then the id exists on disk and is resumed, not created. */
  started: boolean;
  mode: PermissionMode;
  model: string | undefined;
  turn: Turn | undefined;
  live: Live | undefined;
  /** The task list, which outlives a turn. */
  plan: PlanState;
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
 * An ACP v2 agent over the Claude Agent SDK. A session has one Claude process for as long as it is
 * in use: prompts are pushed into its input stream, so a turn after the first does not pay for a
 * start (the first costs about a second and a half; the next ones, nothing).
 *
 * That is memory held per open session (about 230 MB), so a process that has been idle for
 * `idleMs` is let go, and the next prompt starts one again with `resume`. A process that dies
 * does the same. Decision 0007.
 */
export const createAgent = (config: AdapterConfig, runQuery: QueryFn) => {
  const sessions = new Map<string, SessionState>();
  const idleMs = config.idleMs ?? 300_000;
  const cancelGraceMs = config.cancelGraceMs ?? 3_000;

  const notify = (client: AgentContext, sessionId: string, update: SessionUpdate) =>
    client.notify(methods.client.session.update, { sessionId, update });

  const require = (sessionId: string): SessionState => {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw new RequestError(-32002, "Session not found", { sessionId });
    }
    return session;
  };

  /** Lets the session's process go: gracefully, or at once. The next prompt starts another. */
  const release = (session: SessionState, hard: boolean) => {
    const live = session.live;
    if (live === undefined) return;
    session.live = undefined;
    clearTimeout(live.idle);
    live.end();
    if (hard) live.abort.abort();
    else setTimeout(() => live.abort.abort(), 2_000).unref?.();
  };

  /** Ends the turn that is running, once: the usage, then the idle state that tells clients it is over. */
  const finish = async (
    client: AgentContext,
    session: SessionState,
    turn: Turn,
    stop: StopReason,
    usage?: SessionUpdate,
  ) => {
    if (turn.done) return;
    turn.done = true;
    clearTimeout(turn.killTimer);
    if (session.turn === turn) session.turn = undefined;
    if (session.live !== undefined) {
      clearTimeout(session.live.idle);
      session.live.idle = setTimeout(() => release(session, false), idleMs);
      session.live.idle.unref?.();
    }
    try {
      if (usage !== undefined && !turn.cancelled) await notify(client, session.id, usage);
      await notify(client, session.id, {
        sessionUpdate: "state_update",
        state: "idle",
        ...(turn.cancelled ? { stopReason: "cancelled" } : stop),
      } as SessionUpdate);
    } catch {
      // The connection is gone: there is no one to tell.
    }
  };

  /** Starts a process for the session. Its messages go to whatever turn is running. */
  const start = (client: AgentContext, session: SessionState): Live => {
    const queue: SDKUserMessage[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as SDKUserMessage;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
    const abort = new AbortController();
    const options: Options = {
      cwd: session.cwd,
      env: config.env,
      abortController: abort,
      includePartialMessages: true,
      permissionMode: session.mode,
      ...(session.model !== undefined ? { model: session.model } : {}),
      ...(config.claudeExecutable !== undefined
        ? { pathToClaudeCodeExecutable: config.claudeExecutable }
        : {}),
      ...(session.started ? { resume: session.id } : { sessionId: session.id }),
      canUseTool: async (toolName, toolInput, context) => {
        // A cancel ends the question, whether or not the SDK also aborts the signal it gave us.
        const signal = session.turn
          ? AbortSignal.any([context.signal, session.turn.permissions.signal])
          : context.signal;
        const aborted = new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new Error("cancelled"));
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
        aborted.catch(() => undefined);
        // Raced with the signal: a client that never answers must not hold the turn.
        const outcome = await Promise.race([
          client.request(
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
                  rawInput: toolInput,
                },
              },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            } as never,
            { signal } as never,
          ),
          aborted,
        ]).catch((error) => {
          if (signal.aborted) return { outcome: { outcome: "cancelled" } };
          throw error;
        });
        const decision = (outcome as { outcome: { outcome: string; optionId?: string } }).outcome;
        if (decision.outcome === "selected" && decision.optionId === "allow") {
          return { behavior: "allow", updatedInput: toolInput };
        }
        return {
          behavior: "deny",
          message: decision.outcome === "cancelled" ? "Cancelled" : "The user denied it",
          ...(decision.outcome === "cancelled" ? { interrupt: true } : {}),
        };
      },
    };
    const query = runQuery({ prompt: input(), options });
    const live: Live = {
      query,
      abort,
      push: (text) => {
        queue.push({
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        } as SDKUserMessage);
        wake?.();
      },
      end: () => {
        closed = true;
        wake?.();
      },
      idle: undefined,
    };

    // One loop for the life of the process. Whatever turn is running owns what comes out.
    void (async () => {
      let failure: unknown;
      try {
        for await (const message of query as AsyncIterable<SDKMessage>) {
          if (session.live !== live) continue; // let go: nothing it says matters now
          if (message.type === "system" && message.subtype === "init") session.started = true;
          const turn = session.turn;
          if (turn === undefined || turn.done) continue;
          for (const update of turn.translator.feed(message)) {
            await notify(client, session.id, update);
          }
          if (message.type === "result") {
            await finish(
              client,
              session,
              turn,
              stopReasonOf(message),
              turn.translator.usageOf(message),
            );
          }
        }
      } catch (error) {
        failure = error;
      }
      // The process is gone, whatever the reason. A turn that was waiting on it ends here.
      if (session.live === live) session.live = undefined;
      clearTimeout(live.idle);
      const turn = session.turn;
      if (turn !== undefined && !turn.done) {
        await finish(
          client,
          session,
          turn,
          turn.cancelled
            ? { stopReason: "cancelled" }
            : {
                stopReason: "error",
                error: {
                  code: -32603,
                  message:
                    failure instanceof Error
                      ? failure.message
                      : "The Claude process ended before the turn did",
                },
              },
        );
      }
    })();
    return live;
  };

  const runTurn = async (client: AgentContext, session: SessionState, turn: Turn, text: string) => {
    // A cancel can arrive before there is a process: then there is nothing to interrupt.
    if (turn.cancelled) return finish(client, session, turn, { stopReason: "cancelled" });
    try {
      const live = session.live ?? start(client, session);
      session.live = live;
      clearTimeout(live.idle);
      live.push(text);
    } catch (error) {
      await finish(client, session, turn, {
        stopReason: "error",
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  /** Applies a change to a running process; if it cannot, lets the process go so the next one has it. */
  const apply = (session: SessionState, change: (query: Query) => Promise<unknown>) => {
    const live = session.live;
    if (live === undefined) return;
    change(live.query).catch(() => release(session, true));
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
        live: undefined,
        plan: new PlanState(),
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
          live: undefined,
          plan: new PlanState(),
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
      const turn: Turn = {
        translator: new TurnTranslator(session.plan),
        permissions: new AbortController(),
        cancelled: false,
        done: false,
        killTimer: undefined,
      };
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
        }
      })();
      return { messageId };
    })
    .onNotification(methods.agent.session.cancel, async ({ params, client }) => {
      const session = sessions.get(params.sessionId);
      const turn = session?.turn;
      if (session === undefined || turn === undefined || turn.done) return;
      turn.cancelled = true;
      turn.permissions.abort();
      const live = session.live;
      if (live === undefined) return; // not started yet: runTurn sees the flag
      // The process stays up: interrupt ends the turn with a result, and the session goes on. If it
      // does not answer in time, it is killed and the next prompt starts another.
      turn.killTimer = setTimeout(() => {
        release(session, true);
        void finish(client, session, turn, { stopReason: "cancelled" });
      }, cancelGraceMs);
      await live.query.interrupt().catch(() => {
        release(session, true);
        void finish(client, session, turn, { stopReason: "cancelled" });
      });
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      const session = require(params.sessionId);
      const value = "value" in params ? params.value : undefined;
      if (params.configId === "mode") {
        if (!PERMISSION_MODES.includes(value as PermissionMode)) {
          throw new RequestError(-32602, "Unknown permission mode", { value });
        }
        session.mode = value as PermissionMode;
        apply(session, (query) => query.setPermissionMode(session.mode));
      } else if (params.configId === "model" && typeof value === "string") {
        session.model = value;
        apply(session, (query) => query.setModel(value));
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
        session.turn.permissions.abort();
      }
      if (session) release(session, true);
      sessions.delete(params.sessionId);
      return {};
    });
};
