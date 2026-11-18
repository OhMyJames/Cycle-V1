import { randomUUID } from "node:crypto";
import type {
  ElicitationRequest,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentContext,
  agent as acpAgent,
  methods,
  RequestError,
  type SessionConfigOption,
  type SessionUpdate,
} from "@cycle/acp";
import { answersOf, formOf, type Question, questionsOf } from "./ask.ts";
import { type SdkContent, toSdkContent } from "./content.ts";
import { NO_SETUP, type SessionSetup, setupOf } from "./setup.ts";
import { Subagents } from "./subagents.ts";
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
  /**
   * Start the session's process when the session is made, not at its first prompt, so that what a
   * process can say (the slash commands) is known before anything is typed. It costs a process
   * (about 230 MB) for each new session until it is let go after `idleMs`. Default off.
   */
  warmStart?: boolean;
  /**
   * What Claude has recorded about a session, to learn the title it gave it. The SDK's own
   * `getSessionInfo` in the real process; absent means titles are not looked for.
   */
  sessionInfo?: (sessionId: string, cwd: string) => Promise<SessionInfo | undefined>;
};

export type SessionInfo = { summary?: string; customTitle?: string; firstPrompt?: string };

/** The models offered. Aliases: Claude Code resolves them to whatever is current. */
const MODELS = [
  { value: "default", name: "Default" },
  { value: "sonnet", name: "Sonnet" },
  { value: "opus", name: "Opus" },
  { value: "haiku", name: "Haiku" },
];

/** What this agent takes in a prompt beyond text and links (decision 0010). */
export const CLAUDE_PROMPT_CAPABILITIES = { image: {}, embeddedContext: {} } as const;

const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;
type PermissionMode = (typeof PERMISSION_MODES)[number];

type FormResponse = {
  action: string;
  content?: Record<string, unknown> | undefined;
  _meta?: Record<string, unknown>;
};

/** What asking for a form came to: an answer, the turn being cancelled, or no one to ask. */
type FormAnswer =
  | "aborted"
  | "unavailable"
  | { action: string; content?: Record<string, unknown> | undefined };

/** `_meta` key on the daemon's answer when no attached client could be asked (docs/protocol.md §9). */
const NO_CLIENT = "cycle/noClient";

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
  push: (content: string | SdkContent[]) => void;
  /** Ends the input: the process finishes what it is doing and exits. */
  end: () => void;
  idle: ReturnType<typeof setTimeout> | undefined;
};

type SessionState = {
  id: string;
  cwd: string;
  /** False until a process has started the session: then the id exists on disk and is resumed, not created. */
  started: boolean;
  /** The sub-agents the model has started, as far as clients were told. */
  subagents: Subagents;
  mode: PermissionMode;
  model: string | undefined;
  turn: Turn | undefined;
  live: Live | undefined;
  /** The task list, which outlives a turn. */
  plan: PlanState;
  /** Directories, MCP servers and system prompt: what a process is started with, every time. */
  setup: SessionSetup;
  /** The title last told to the client, so it is not told twice. */
  title: string | undefined;
  /** The id of the compaction that is running, if one is. */
  compaction: string | undefined;
  /** Who to tell when something ends outside a turn (a compaction cut short). */
  client: AgentContext | undefined;
  /** True while a mode the user chose is on its way to the process: what it says meanwhile is stale. */
  modeChanging: boolean;
};

const modelOptions = (session: SessionState) =>
  session.model === undefined || MODELS.some((m) => m.value === session.model)
    ? MODELS
    : [...MODELS, { value: session.model, name: session.model }];

const configOptions = (session: SessionState): SessionConfigOption[] =>
  [
    {
      configId: "model",
      name: "Model",
      type: "select",
      currentValue: session.model ?? "default",
      options: modelOptions(session),
    },
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
  /** Whether the client said, in `initialize`, that it can answer a form. One client per adapter. */
  let clientCanElicit = false;
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

  /** A compaction that did not finish because its process went: it is over, and says so. */
  const endCompaction = (session: SessionState) => {
    const compactionId = session.compaction;
    if (compactionId === undefined) return;
    session.compaction = undefined;
    if (session.client === undefined) return;
    void notify(session.client, session.id, {
      sessionUpdate: "compaction_update",
      compactionId,
      status: "cancelled",
    } as SessionUpdate).catch(() => undefined);
  };

  /** Sub-agents that were running when their process went are over, and clients are told. */
  const endSubagents = (session: SessionState) => {
    const ended = session.subagents.endAll();
    if (session.client === undefined) return;
    const client = session.client;
    for (const update of ended) void notify(client, session.id, update).catch(() => undefined);
  };

  /** Lets the session's process go: gracefully, or at once. The next prompt starts another. */
  const release = (session: SessionState, hard: boolean) => {
    const live = session.live;
    if (live === undefined) return;
    endCompaction(session);
    endSubagents(session);
    session.live = undefined;
    clearTimeout(live.idle);
    live.end();
    if (hard) live.abort.abort();
    else setTimeout(() => live.abort.abort(), 2_000).unref?.();
  };

  /** Tells the client the title Claude gave the session, once per change. Never throws. */
  const announceTitle = async (client: AgentContext, session: SessionState) => {
    if (config.sessionInfo === undefined) return;
    try {
      const info = await config.sessionInfo(session.id, session.cwd);
      if (info === undefined) return;
      // `summary` falls back to the first prompt when Claude has not given the session a title.
      const generated = info.summary !== info.firstPrompt ? info.summary : undefined;
      const title = info.customTitle ?? generated;
      if (title === undefined || title === "" || title === session.title) return;
      session.title = title;
      await notify(client, session.id, {
        sessionUpdate: "session_info_update",
        title,
      } as SessionUpdate);
    } catch {
      // No title is not a failure.
    }
  };

  const commandsUpdate = (commands: readonly SlashCommand[]): SessionUpdate => {
    const seen = new Set<string>();
    const availableCommands = [];
    for (const command of commands) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      availableCommands.push({
        type: "command",
        name: command.name,
        description: command.description,
        ...(command.argumentHint ? { input: { type: "text", hint: command.argumentHint } } : {}),
      });
    }
    return { sessionUpdate: "available_commands_update", availableCommands } as SessionUpdate;
  };

  /**
   * What a process says that is not part of a turn: the mode it changed itself (a plan approved),
   * a compaction, a new list of commands. These are the session's, and can come between turns.
   */
  const aside = async (client: AgentContext, session: SessionState, message: SDKMessage) => {
    if (message.type !== "system") return;
    const m = message as unknown as Record<string, unknown> & { subtype: string };
    if (m.subtype.startsWith("task_")) {
      const update = session.subagents.update(m);
      if (update !== undefined) await notify(client, session.id, update);
    } else if (m.subtype === "commands_changed") {
      await notify(client, session.id, commandsUpdate(m.commands as SlashCommand[]));
    } else if (m.subtype === "status") {
      const mode = m.permissionMode as PermissionMode | undefined;
      if (
        mode !== undefined &&
        PERMISSION_MODES.includes(mode) &&
        mode !== session.mode &&
        !session.modeChanging
      ) {
        session.mode = mode;
        await notify(client, session.id, {
          sessionUpdate: "config_option_update",
          configOptions: configOptions(session),
        } as SessionUpdate);
      }
      if (m.status === "compacting" && session.compaction === undefined) {
        session.compaction = randomUUID();
        await notify(client, session.id, {
          sessionUpdate: "compaction_update",
          compactionId: session.compaction,
          status: "in_progress",
        } as SessionUpdate);
      } else if (m.status !== "compacting" && session.compaction !== undefined) {
        const failed = m.compact_result === "failed";
        const compactionId = session.compaction;
        session.compaction = undefined;
        await notify(client, session.id, {
          sessionUpdate: "compaction_update",
          compactionId,
          status: failed ? "failed" : "completed",
          ...(failed && typeof m.compact_error === "string" ? { error: m.compact_error } : {}),
        } as SessionUpdate);
      }
    }
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
    if (!turn.cancelled) void announceTitle(client, session);
  };

  /**
   * Asks the user a form, through the daemon. Ends when someone answers, or when the turn is
   * cancelled or the process gives up on it (`signal`). `undefined`: it was cancelled.
   */
  const askForm = async (
    client: AgentContext,
    session: SessionState,
    form: { message: string; requestedSchema: unknown },
    signal: AbortSignal,
  ): Promise<FormAnswer> => {
    // A client that did not say it can show a form is not sent one (ACP: the capability is the opt-in).
    if (!clientCanElicit) return "unavailable";
    const all = session.turn ? AbortSignal.any([signal, session.turn.permissions.signal]) : signal;
    const aborted = new Promise<"aborted">((resolve) => {
      if (all.aborted) resolve("aborted");
      all.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const answer = client
      .request(
        methods.client.elicitation.create,
        { sessionId: session.id, mode: "form", ...form } as never,
        { signal: all } as never,
      )
      .then(
        (r) => r as unknown as FormResponse,
        () => "failed" as const,
      );
    const response = await Promise.race([answer, aborted]);
    if (response === "aborted") return "aborted";
    // A request that failed (a host that does not know the method, a broken connection) is not the
    // user saying no: it is nobody to ask. Only an abort ends the turn.
    if (response === "failed") return all.aborted ? "aborted" : "unavailable";
    if (response._meta?.[NO_CLIENT] === true) return "unavailable";
    return { action: response.action, content: response.content };
  };

  /** An MCP server asks the user for input. Without a client that can answer it is declined. */
  const elicit = async (
    client: AgentContext,
    session: SessionState,
    request: ElicitationRequest,
    signal: AbortSignal,
  ) => {
    if (request.mode === "url" || request.requestedSchema === undefined) {
      return { action: "decline" as const };
    }
    const answer = await askForm(
      client,
      session,
      { message: request.message, requestedSchema: request.requestedSchema },
      signal,
    );
    if (answer === "aborted") return { action: "cancel" as const };
    if (answer === "unavailable") return { action: "decline" as const };
    if (answer.action === "accept") {
      return {
        action: "accept" as const,
        content: (answer.content ?? {}) as Record<string, string>,
      };
    }
    return { action: answer.action === "decline" ? ("decline" as const) : ("cancel" as const) };
  };

  /**
   * `AskUserQuestion` as a form. `undefined` when it cannot be one (no client can answer a form, or
   * the input is not what the tool takes): the caller asks it as a permission, which is what it was.
   */
  const askQuestions = async (
    client: AgentContext,
    session: SessionState,
    input: Record<string, unknown>,
    context: { signal: AbortSignal },
  ): Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string; interrupt?: boolean }
    | undefined
  > => {
    const questions: Question[] | undefined = questionsOf(input);
    if (questions === undefined) return undefined;
    const answer = await askForm(client, session, formOf(questions), context.signal);
    if (answer === "aborted") return { behavior: "deny", message: "Cancelled", interrupt: true };
    if (answer === "unavailable") return undefined;
    // A dismissed form is a cancel, as a dismissed permission card is: it ends the turn. The daemon
    // answers a cancelled turn's forms this way before the cancel itself arrives.
    if (answer.action === "cancel")
      return { behavior: "deny", message: "Cancelled", interrupt: true };
    if (answer.action !== "accept") {
      return { behavior: "deny", message: "The user declined to answer" };
    }
    const answers = answersOf(questions, answer.content);
    // Nothing is required, so a form can come back empty: that is not an answer.
    if (Object.keys(answers).length === 0) {
      return { behavior: "deny", message: "The user did not answer" };
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  };

  /** Starts a process for the session. Its messages go to whatever turn is running. */
  const start = (client: AgentContext, session: SessionState): Live => {
    session.client = client;
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
      ...(session.setup.additionalDirectories.length > 0
        ? { additionalDirectories: session.setup.additionalDirectories }
        : {}),
      ...(Object.keys(session.setup.mcpServers).length > 0
        ? // Over stdin, not argv: a server's env and headers can hold secrets.
          { mcpServers: session.setup.mcpServers, mcpServersDelivery: "initialize" as const }
        : {}),
      ...(session.setup.systemPrompt !== undefined
        ? { systemPrompt: session.setup.systemPrompt }
        : {}),
      onElicitation: (request, { signal }) => elicit(client, session, request, signal),
      abortController: abort,
      includePartialMessages: true,
      // So that a sub-agent's row can say what it is doing, not only that it is busy.
      agentProgressSummaries: true,
      permissionMode: session.mode,
      ...(session.model !== undefined ? { model: session.model } : {}),
      ...(config.claudeExecutable !== undefined
        ? { pathToClaudeCodeExecutable: config.claudeExecutable }
        : {}),
      ...(session.started ? { resume: session.id } : { sessionId: session.id }),
      canUseTool: async (toolName, toolInput, context) => {
        if (toolName === "AskUserQuestion") {
          const answered = await askQuestions(client, session, toolInput, context);
          if (answered !== undefined) return answered;
          // Nobody behind the daemon can answer a form: it is a permission card, as it was.
        }
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
      push: (content) => {
        queue.push({
          type: "user",
          message: { role: "user", content },
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

    // The commands it has: the list of what a user can type after a slash.
    void (async () => {
      try {
        const commands = await query.supportedCommands();
        if (session.live === live && commands.length > 0) {
          await notify(client, session.id, commandsUpdate(commands));
        }
      } catch {
        // A process that cannot say is a process with no commands to show.
      }
    })();

    // One loop for the life of the process. Whatever turn is running owns what comes out.
    void (async () => {
      let failure: unknown;
      try {
        for await (const message of query as AsyncIterable<SDKMessage>) {
          if (session.live !== live) continue; // let go: nothing it says matters now
          // Only once there is a prompt: a process started ahead of one has made no session on disk to resume.
          if (
            message.type === "system" &&
            message.subtype === "init" &&
            session.turn !== undefined
          ) {
            session.started = true;
          }
          await aside(client, session, message).catch(() => undefined);
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
      if (session.live === live) {
        session.live = undefined;
        endCompaction(session);
        endSubagents(session);
      }
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

  const runTurn = async (
    client: AgentContext,
    session: SessionState,
    turn: Turn,
    content: string | SdkContent[],
  ) => {
    // A cancel can arrive before there is a process: then there is nothing to interrupt.
    if (turn.cancelled) return finish(client, session, turn, { stopReason: "cancelled" });
    try {
      const live = session.live ?? start(client, session);
      session.live = live;
      clearTimeout(live.idle);
      live.push(content);
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
    if (live === undefined) return Promise.resolve();
    return change(live.query).catch(() => release(session, true));
  };

  return acpAgent({ name: "cycle-claude-adapter" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      clientCanElicit = params.capabilities?.elicitation?.form != null;
      return {
        protocolVersion: 2,
        info: { name: "cycle-claude-adapter", version: "0.0.0" },
        capabilities: {
          session: {
            prompt: CLAUDE_PROMPT_CAPABILITIES,
            mcp: { stdio: {}, http: {} },
            additionalDirectories: {},
            systemPrompt: {},
          },
        },
      };
    })
    .onRequest(methods.agent.session.new, ({ params, client }) => {
      const proposed = (params._meta as Record<string, unknown> | null | undefined)?.[PROPOSED_ID];
      // Take the daemon's id when it is a UUID, which is all the SDK accepts; otherwise make one.
      const id = typeof proposed === "string" && UUID.test(proposed) ? proposed : randomUUID();
      const session: SessionState = {
        id,
        cwd: params.cwd,
        started: false,
        subagents: new Subagents(),
        mode: "default",
        model: undefined,
        turn: undefined,
        live: undefined,
        plan: new PlanState(),
        setup: setupOf(params),
        title: undefined,
        compaction: undefined,
        client: undefined,
        modeChanging: false,
      };
      sessions.set(id, session);
      if (config.warmStart === true) {
        try {
          const live = start(client, session);
          session.live = live;
          // Not used soon: let it go, as any idle process is.
          live.idle = setTimeout(() => release(session, false), idleMs);
          live.idle.unref?.();
        } catch {
          // A process that cannot start now is started, or fails, at the first prompt.
        }
      }
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
          subagents: new Subagents(),
          mode: "default",
          model: undefined,
          turn: undefined,
          live: undefined,
          plan: new PlanState(),
          setup: NO_SETUP,
          title: undefined,
          compaction: undefined,
          client: undefined,
          modeChanging: false,
        } satisfies SessionState);
      // What the daemon sends again on a resume is what the next process is started with.
      session.setup = setupOf(params);
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
      // Refused whole, before there is a turn: a block that cannot be carried is not dropped.
      const content = toSdkContent(params.prompt);
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
          await runTurn(client, session, turn, content);
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
        // What the process says about its mode before it has this one is old news: not a change.
        session.modeChanging = true;
        apply(session, (query) => query.setPermissionMode(session.mode)).finally(() => {
          session.modeChanging = false;
        });
      } else if (params.configId === "model" && typeof value === "string") {
        // "default" is no choice: Claude Code picks.
        session.model = value === "default" ? undefined : value;
        const model = session.model;
        apply(session, (query) => query.setModel(model));
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
