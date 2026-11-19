// The dictionary of what the app reports about how it is used. Nothing else is sent: `track` drops an event that is
// not here, and a property that is not in its schema.
//
// The rule that shapes every schema: a property is a number, a boolean, or one of a fixed list of words. Never a
// string the user or an agent wrote (a prompt, a path, a title, a command, a message, a repository). So there is no
// `z.string()` in this file, and a new one needs a decision (.agents/notes/2026-11-19-product-analytics-posthog.md).

import { z } from "zod";

const count = z.number().int().min(0);
const agent = z.enum(["claude", "other"]);
const environment = z.enum(["local", "remote"]);
const size = z.enum(["short", "medium", "long"]);
const panel = z.enum([
  "search",
  "new_session",
  "add_environment",
  "defaults",
  "session_settings",
  "rename",
  "delete",
  "trust",
]);

const o = z.strictObject;

/** Every event, and the properties it may carry. */
export const EVENTS = {
  // ---- the app ----
  /** The app started. */
  app_launched: o({ remote_environments: count, first_run: z.boolean() }),
  /** The person turned usage statistics on or off. Sent last when turning off, first when turning on. */
  analytics_toggled: o({ enabled: z.boolean() }),
  /** The person asked to check for an update. */
  update_checked: o({ result: z.enum(["available", "up_to_date", "error", "disabled"]) }),
  update_install_started: o({}),

  // ---- environments ----
  environment_saved: o({ transport: z.enum(["ssh"]) }),
  environment_removed: o({ kind: environment }),
  /** The person had the app update the daemon of a remote environment (not the hand-run command), and it worked or not. */
  daemon_upgraded: o({ ok: z.boolean() }),
  /** An environment's connection changed: it is up, it dropped and is trying again, or it is closed. */
  environment_connection: o({
    kind: environment,
    state: z.enum(["connected", "reconnecting", "closed"]),
  }),

  // ---- sessions ----
  session_created: o({ agent, environment: environment, configured: z.boolean() }),
  session_opened: o({ agent, environment: environment }),
  session_renamed: o({}),
  session_archived: o({ archived: z.boolean() }),
  /** After the person confirmed it (AGENTS.md: a delete is confirmed by the client first). */
  session_deleted: o({}),
  session_config_changed: o({ setting: z.enum(["mode", "model", "other"]) }),
  agent_defaults_saved: o({ agent }),
  /** A session that was working changed to something the person is told of: it finished, it needs them, or it stopped. */
  session_attention: o({ kind: z.enum(["finished", "needs-you", "stopped"]) }),

  // ---- the conversation ----
  prompt_sent: o({
    agent,
    environment: environment,
    size,
    images: count,
    mentions: count,
    /** Sent into the running turn (Enter) instead of queued. */
    steered: z.boolean(),
  }),
  prompt_cancelled: o({ agent }),
  permission_answered: o({
    outcome: z.enum(["allowed", "rejected", "cancelled"]),
    remembered: z.boolean(),
  }),

  // ---- the interface (the only ones the page may send) ----
  panel_opened: o({ panel, via: z.enum(["click", "shortcut"]) }),
  code_theme_changed: o({}),
  slash_command_used: o({}),
} as const;

export type EventName = keyof typeof EVENTS;
export type EventProps<N extends EventName> = z.infer<(typeof EVENTS)[N]>;

/** What the page may report itself, through the bridge. The rest happen in main, where the page cannot forge them. */
export const UI_EVENTS = [
  "panel_opened",
  "code_theme_changed",
  "slash_command_used",
] as const satisfies readonly EventName[];
export type UiEventName = (typeof UI_EVENTS)[number];

export const isEventName = (name: string): name is EventName => Object.hasOwn(EVENTS, name);
export const isUiEvent = (name: string): name is UiEventName =>
  (UI_EVENTS as readonly string[]).includes(name);

// ---- words for what is not one of a list: the id of an agent, a setting, a length ----

/** Agents we know by name; any other is "other", so a custom agent's id is not sent. */
export const agentOf = (id: string): z.infer<typeof agent> =>
  id === "claude" ? "claude" : "other";

export const settingOf = (configId: string): "mode" | "model" | "other" =>
  configId === "mode" || configId === "model" ? configId : "other";

/** How long a prompt is, in three words: the length is as much as is learned of it. */
export const sizeOf = (characters: number): z.infer<typeof size> =>
  characters < 200 ? "short" : characters < 2000 ? "medium" : "long";
