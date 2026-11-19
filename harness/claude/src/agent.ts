import { randomUUID } from "node:crypto";
import {
  type AgentContext,
  agent as acpAgent,
  methods,
  RequestError,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type {
  ElicitationRequest,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { answersOf, formOf, type Question, questionsOf } from "./ask.ts";
import { type SdkContent, toSdkContent } from "./content.ts";
import { NO_SETUP, type SessionSetup, setupOf } from "./setup.ts";
import { Subagents } from "./subagents.ts";
import { PlanState, type StopReason, stopReasonOf, TurnTranslator, toolKind } from "./translate.ts";
import { claudeJsonPath, recordTrust } from "./trust.ts";

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
  /** How many processes started ahead of a first prompt may be held at once; the oldest is let go. Default 3. */
  maxWarm?: number;
  /** Ask the SDK for model-written progress lines for sub-agents (a model call each). Default off. */
  progressSummaries?: boolean;
  /**
   * What Claude has recorded about a session, to learn the title it gave it. The SDK's own
   * `getSessionInfo` in the real process; absent means titles are not looked for.
   */
  sessionInfo?: (sessionId: string, cwd: string) => Promise<SessionInfo | undefined>;
};

export type SessionInfo = { summary?: string; customTitle?: string; firstPrompt?: string };

/**
 * The models offered. Aliases: Claude Code resolves them to whatever is current. The daemon's `configSchema` is built
 * from this list too. "Default model", not "Default": the name is shown alone, beside the message box.
 */
export const CLAUDE_MODELS = [
  { value: "default", name: "Default model" },
  { value: "sonnet", name: "Sonnet" },
  { value: "opus", name: "Opus" },
  { value: "haiku", name: "Haiku" },
];

/** What this agent takes in a prompt beyond text and links (decision 0010). */
export const CLAUDE_PROMPT_CAPABILITIES = { image: {}, embeddedContext: {} } as const;

/**
 * Every permission mode the SDK has, with what a person needs to choose one, the suggested one first. The values are the
 * SDK's own and are what is stored, so they are never renamed; only `name` and `description` are
 * ours. The daemon's `configSchema` is built from this list too, so the two always agree. The
 * suggested one carries `META.recommended` of `@cycle/protocol` in its `_meta`.
 */
export const CLAUDE_PERMISSION_MODES = [
  {
    value: "auto",
    name: "Auto",
    description:
      "A model reviews each action and allows or denies it, and asks you when it cannot tell. Not every account has it.",
    _meta: { "cycle/recommended": true },
  },
  {
    value: "default",
    name: "Ask before acting",
    description:
      "Asks you before Claude edits a file or runs a command. Reading is allowed without asking.",
  },
  {
    value: "acceptEdits",
    name: "Accept edits",
    description:
      "Edits to files in the working folder are allowed without asking. Commands still ask.",
  },
  {
    value: "plan",
    name: "Plan mode",
    description:
      "Claude reads and writes a plan but changes nothing. It starts work only after you approve the plan.",
  },
  {
    value: "dontAsk",
    name: "Don't ask",
    description:
      "Never asks. Any edit or command that settings have not already allowed is denied, so without allow rules Claude can only read.",
  },
  {
    value: "bypassPermissions",
    name: "Bypass permissions",
    description:
      "Every edit and command runs without asking. Use only where Claude can do no harm, such as a sandbox.",
    _meta: { "cycle/danger": true },
  },
] as const;

type PermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number]["value"];
/** What a new session starts in, and what is offered as the one to use. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";
const PERMISSION_MODES: readonly string[] = CLAUDE_PERMISSION_MODES.map((m) => m.value);

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
/** In `session/resume`: a turn of the session was answered, so Claude must have a record of it (`META.hadTurn`). */
const HAD_TURN = "cycle/hadTurn";
/** On `session/prompt`: put it into the turn that is running (`META.steer`, docs/protocol.md §8). */
const STEER = "cycle/steer";

type Turn = {
  translator: TurnTranslator;
  /** Aborted on cancel: it ends a permission request that is still waiting for an answer. */
  permissions: AbortController;
  cancelled: boolean;
  done: boolean;
  /**
   * Prompts put into this turn that Claude has not yet said it took (a result's `user_message_uuids`).
   * While there are any, a result does not end the turn: Claude goes on with them.
   */
  steers: Set<string>;
  /** The turn's own prompt is in the process: only then can another be put after it. */
  pushed: boolean;
  /** The process this turn runs on: the one whose exit ends it. */
  process: Live | undefined;
  killTimer: ReturnType<typeof setTimeout> | undefined;
};

/** A Claude process, and the stream that feeds it. It lives for many turns. */
type Live = {
  query: Query;
  abort: AbortController;
  /**
   * Hands the process a user message. `uuid` is how a result names it among what it took; `next`:
   * into the turn that is running, at its next tool call.
   */
  push: (content: string | SdkContent[], uuid: string, priority?: "next") => void;
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
  /** The command list clients were last told, to say it again only when it changes. */
  commandsKey: string | undefined;
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
  modeChanging: number;
};

const modelOptions = (session: SessionState) =>
  session.model === undefined || CLAUDE_MODELS.some((m) => m.value === session.model)
    ? CLAUDE_MODELS
    : [...CLAUDE_MODELS, { value: session.model, name: session.model }];

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
      options: CLAUDE_PERMISSION_MODES.map((m) => ({ ...m })),
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
  /** Sessions whose process was started ahead of a prompt and has had none yet, oldest first. */
  const warm = new Set<SessionState>();
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
    warm.delete(session);
    session.live = undefined;
    clearTimeout(live.idle);
    live.end();
    if (hard) live.abort.abort();
    else setTimeout(() => live.abort.abort(), 2_000).unref?.();
  };

  /**
   * Whether Claude has this session on disk, so that the next process resumes it (it has the id) instead of
   * starting it (it would refuse an id it already knows, or has none to resume). Claude writes the session
   * when it takes the first prompt, not when Cycle makes the session: one that has had no prompt has nothing to
   * resume. If it should have a record (a turn was answered) and has none, the history is lost, and that is said
   * rather than a new conversation begun under the old name. Where there is no way to look (no config
   * directory given to Claude), or looking fails, the session is taken to be there, as it was before.
   */
  const recordOf = async (sessionId: string, cwd: string, hadTurn: boolean): Promise<boolean> => {
    if (config.sessionInfo === undefined) return true;
    let found: boolean;
    try {
      found = (await config.sessionInfo(sessionId, cwd)) !== undefined;
    } catch {
      return true;
    }
    if (found) return true;
    if (hadTurn) {
      throw new RequestError(
        -32603,
        "Claude has no record of this session any more: its history can be read, but it cannot be continued",
        { sessionId },
      );
    }
    return false;
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

  /** Announces the commands, unless they are the ones the clients were last told: a process that starts again has the same ones. */
  const announceCommands = async (
    client: AgentContext,
    session: SessionState,
    commands: readonly SlashCommand[],
  ) => {
    const update = commandsUpdate(commands);
    const key = JSON.stringify((update as { availableCommands: unknown }).availableCommands);
    if (key === session.commandsKey) return;
    await notify(client, session.id, update);
    // Only once it was sent: a list that did not get there is said again.
    session.commandsKey = key;
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
      await announceCommands(client, session, m.commands as SlashCommand[]);
    } else if (m.subtype === "status") {
      const mode = m.permissionMode as PermissionMode | undefined;
      if (
        mode !== undefined &&
        PERMISSION_MODES.includes(mode) &&
        mode !== session.mode &&
        session.modeChanging === 0
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
      for (const update of turn.translator.unfinished()) await notify(client, session.id, update);
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
    let forget = () => {};
    const aborted = new Promise<"aborted">((resolve) => {
      if (all.aborted) resolve("aborted");
      const onAbort = () => resolve("aborted");
      all.addEventListener("abort", onAbort, { once: true });
      // The signal can be one that lives as long as the process: a listener is not left on it.
      forget = () => all.removeEventListener("abort", onAbort);
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
    const response = await Promise.race([answer, aborted]).finally(forget);
    if (response === "aborted") return "aborted";
    // A request that failed (a host that does not know the method, a broken connection) is not the
    // user saying no: it is nobody to ask. Only an abort ends the turn.
    if (response === "failed") return all.aborted ? "aborted" : "unavailable";
    // Not an answer at all (a client that sent null): nobody to ask.
    if (typeof response !== "object" || response === null) return "unavailable";
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
    // Before the process reads it: whether this folder may run its own configuration's commands.
    if (session.setup.trusted !== undefined) {
      const file = claudeJsonPath(config.env);
      const result =
        file === undefined ? undefined : recordTrust(file, session.cwd, session.setup.trusted);
      if (typeof result === "object") {
        console.error(`cycle: folder trust not recorded for ${session.cwd}: ${result.failed}`);
      }
    }
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
      // A sub-agent's row can say what it is doing, not only that it is busy. The SDK makes a
      // model call for each summary, so it is asked for only when the configuration says to.
      ...(config.progressSummaries === true ? { agentProgressSummaries: true } : {}),
      permissionMode: session.mode,
      // The SDK's guard against starting in bypassPermissions by accident. Here the mode is only
      // ever the one a person chose, and without this a switch to it mid-session would be refused
      // and cost the process. The flag allows the mode; it does not turn it on.
      allowDangerouslySkipPermissions: true,
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
      push: (content, uuid, priority) => {
        queue.push({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          uuid,
          ...(priority !== undefined ? { priority } : {}),
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
          await announceCommands(client, session, commands);
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
          // A turn that went through means the session is on disk, whenever the process said hello.
          if (
            message.type === "result" &&
            (message as { subtype?: string }).subtype === "success"
          ) {
            session.started = true;
          }
          // Only once there is a prompt: a process started ahead of one has made no session on disk to resume.
          if (
            message.type === "system" &&
            message.subtype === "init" &&
            session.turn !== undefined
          ) {
            session.started = true;
          }
          await aside(client, session, message).catch(() => undefined);
          let turn = session.turn;
          if ((turn === undefined || turn.done) && speaksAloneOf(message)) {
            // Claude began on its own (a background task finished and woke it): there is no prompt, but
            // there is a turn to show, from its first words to its result. It exists before anything is
            // awaited, so a prompt or a cancel that arrives meanwhile finds it.
            turn = beginOwnTurn(session, live);
            await notify(client, session.id, {
              sessionUpdate: "state_update",
              state: "running",
            } as SessionUpdate).catch(() => undefined);
          }
          if (turn === undefined || turn.done) continue;
          for (const update of turn.translator.feed(message)) {
            // The turn can end while this waits (a cancel that ran out of time): nothing more is its.
            if (turn.done) break;
            await notify(client, session.id, update);
          }
          if (message.type === "result") {
            // What was put into the turn and not taken before it ended is Claude's next to answer,
            // in the same process: the turn goes on until that is answered too.
            // A result that does not say what it took (the SDK leaves it out of failed ones) says
            // nothing about them either: the turn ends, and the process goes with them below.
            const taken = (message as { user_message_uuids?: string[] }).user_message_uuids;
            if (taken !== undefined) for (const id of taken) turn.steers.delete(id);
            if (taken !== undefined && turn.steers.size > 0 && !turn.cancelled) continue;
            // A turn that ends with something put into it still waiting (stopped, or unknown): Claude
            // would answer it afterwards, with no turn to show it in. The process goes before it can begin
            // that; the next prompt starts another, which resumes the session.
            if (turn.steers.size > 0) release(session, true);
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
      // Only a turn that was running on this process ends with it: an exit that comes late, after
      // another process has taken over the session, says nothing of that one's turn.
      const turn = session.turn;
      if (turn !== undefined && !turn.done && turn.process === live) {
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

  /**
   * Whether a message is the main agent beginning a message of its own: the start of one, which is what a turn that
   * nobody prompted opens with. Not what a process says between turns (modes, commands, task news), not the tail of
   * a turn that has ended, and not a sub-agent's talk (`parent_tool_use_id`).
   */
  const speaksAloneOf = (message: SDKMessage): boolean =>
    message.type === "stream_event" &&
    (message.event as { type?: string }).type === "message_start" &&
    !(message as { parent_tool_use_id?: string | null }).parent_tool_use_id;

  /** A turn with nothing in it yet. `process` is the one it runs on, once there is one. */
  const newTurn = (session: SessionState, process?: Live): Turn => ({
    translator: new TurnTranslator(session.plan, Object.keys(session.setup.mcpServers)),
    permissions: new AbortController(),
    cancelled: false,
    done: false,
    steers: new Set(),
    pushed: process !== undefined,
    process,
    killTimer: undefined,
  });

  /** A turn nobody prompted: its process is already running it. */
  const beginOwnTurn = (session: SessionState, live: Live): Turn => {
    clearTimeout(live.idle);
    warm.delete(session); // it is at work: not one held ahead of a prompt
    const turn = newTurn(session, live);
    session.turn = turn;
    return turn;
  };

  const runTurn = async (
    client: AgentContext,
    session: SessionState,
    turn: Turn,
    content: string | SdkContent[],
    messageId: string,
  ) => {
    // A cancel can arrive before there is a process: then there is nothing to interrupt.
    if (turn.cancelled) return finish(client, session, turn, { stopReason: "cancelled" });
    try {
      warm.delete(session); // it has its prompt
      const live = session.live ?? start(client, session);
      session.live = live;
      clearTimeout(live.idle);
      turn.process = live;
      live.push(content, messageId);
      turn.pushed = true;
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
        commandsKey: undefined,
        mode: DEFAULT_PERMISSION_MODE,
        model: undefined,
        turn: undefined,
        live: undefined,
        plan: new PlanState(),
        setup: setupOf(params),
        title: undefined,
        compaction: undefined,
        client: undefined,
        modeChanging: 0,
      };
      sessions.set(id, session);
      if (config.warmStart === true) {
        try {
          const live = start(client, session);
          session.live = live;
          // Not without end: a client that makes many sessions does not get that many processes.
          warm.add(session);
          for (const old of warm) {
            if (warm.size <= (config.maxWarm ?? 3)) break;
            release(old, false);
          }
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
      const hadTurn =
        (params._meta as Record<string, unknown> | null | undefined)?.[HAD_TURN] === true;
      // Looked at before the session is taken or made: nothing is awaited between the two.
      const started =
        sessions.has(params.sessionId) || (await recordOf(params.sessionId, params.cwd, hadTurn));
      const session =
        sessions.get(params.sessionId) ??
        ({
          id: params.sessionId,
          cwd: params.cwd,
          // Whether Claude has this session on disk (see `recordOf`): it is resumed if so, and made if not.
          started,
          subagents: new Subagents(),
          commandsKey: undefined,
          // Not the default for new sessions: a session with no mode on record was made before
          // that default was auto, and ran asking first. Resuming it must not loosen that.
          mode: "default",
          model: undefined,
          turn: undefined,
          live: undefined,
          plan: new PlanState(),
          setup: NO_SETUP,
          title: undefined,
          compaction: undefined,
          client: undefined,
          modeChanging: 0,
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
      const steer = (params._meta as Record<string, unknown> | null | undefined)?.[STEER] === true;
      const running = session.turn;
      if (steer) {
        // Only into a turn that is going on, in a process that has it: anything else is the
        // daemon's to queue or send (docs/protocol.md §8).
        const live = session.live;
        // Not before the turn's own prompt is in the process, or Claude would read this one first.
        if (
          running === undefined ||
          running.done ||
          running.cancelled ||
          !running.pushed ||
          live === undefined
        ) {
          throw new RequestError(-32600, "No turn is running to take it", {
            sessionId: session.id,
          });
        }
        const content = toSdkContent(params.prompt);
        const messageId = randomUUID();
        running.steers.add(messageId);
        live.push(content, messageId, "next");
        void notify(client, session.id, {
          sessionUpdate: "user_message",
          messageId,
          content: params.prompt,
        } as SessionUpdate).catch(() => undefined);
        return { messageId };
      }
      if (running !== undefined) {
        throw new RequestError(-32600, "A turn is already running", { sessionId: session.id });
      }
      // Refused whole, before there is a turn: a block that cannot be carried is not dropped.
      const content = toSdkContent(params.prompt);
      const messageId = randomUUID();
      // The turn exists from here, before anything is awaited: a cancel or a second prompt that
      // arrives while the first notifications are going out must find it.
      const turn = newTurn(session);
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
          await runTurn(client, session, turn, content, messageId);
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
        // A count, not a flag: with two changes in flight the first to finish is not the last.
        session.modeChanging++;
        apply(session, (query) => query.setPermissionMode(session.mode)).finally(() => {
          session.modeChanging--;
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
