// The source language of the interface. Add a key here first; a translation is a file beside this one with the same keys.
// Keys are named by where the text is (`search.placeholder`), not by what it says, so that rewording does not rename them.
// Write whole sentences. Never build one from pieces (`"Delete " + name`): other languages order the words differently.
// A number of things is a plural message with `count`; a name or a path is a `{placeholder}`.
import type { Messages } from "../i18n.ts";

export const enUS = {
  // The session search (Cmd+K)
  "search.label": "Search sessions",
  "search.placeholder": "Search sessions by title, folder, agent or environment",
  "search.empty": "No session matches that.",
  "search.group.actions": "Actions",
  "search.action.newSession": "New session",
  "search.archived": "archived",
  "search.open": "Search sessions",

  // Environments that are away, and starting a session on one of several
  "session.away": "{environment} · {state}",
  "session.awayBanner":
    "{environment} is not connected. This is what the session had when it went away.",
  "defaults.unreadable":
    "The saved settings of this agent could not be read, so they are not shown. Close this and open it again.",
  "newSession.environment": "Environment",

  // A new session before its first message: the blank conversation
  "blank.title": "New session",
  "blank.where": "Where the session runs",
  "blank.folder": "Folder",
  "blank.folder.placeholder": "/path/to/project",
  "blank.agent": "Agent",
  "blank.lead": "The session starts when you send the first message.",
  "blank.chooseFolder": "Choose a folder for the agent to work in.",
  "blank.noAgent": "No agent is available on {environment}.",
  "blank.unreadable":
    "The saved settings of this agent could not be read, so the session cannot start from them.",
  "blank.retry": "Read settings again",
  "blank.starting": "Starting the session…",
  "blank.settings": "Settings for the new session",
  "blank.settings.lead": "The session starts with these. You can change them later.",

  // Images in a conversation
  "image.open": "Open image: {name}",
  "image.alt.agent": "Image from the agent",
  "image.alt.user": "Image you sent",
  "image.close": "Close",
  "image.unsupported": "An image that cannot be shown ({type})",
  "image.tooLarge": "An image too large to show ({size})",

  // Writing a message and attaching images
  "composer.attach": "Attach image",
  "composer.remove": "Remove {name}",
  "composer.attached": "Attached images",
  "composer.drop": "Drop images to attach them",
  "composer.problem.type": "{name} is not a PNG, JPEG, GIF or WebP image.",
  "composer.problem.blockTooLarge": "{name} is larger than {limit}.",
  "composer.problem.promptTooLarge": "Together, the images are larger than {limit}.",
  "composer.problem.tooMany": {
    one: "You can attach {count} image at most.",
    other: "You can attach {count} images at most.",
  },
  "composer.problem.unreadable": "{name} could not be read.",

  // The box a message is written in
  "composer.message": "Message",
  "composer.offline": "Connection lost. You can keep editing your draft.",
  "composer.placeholder.idle": "Message the agent",
  "composer.placeholder.working": "Queue a message for when the agent is done",
  "composer.placeholder.busy": "The agent is working. Stop it to send a message now.",
  "composer.placeholder.steer": "Enter to send now, Shift+Enter to queue",
  "composer.send": "Send",
  "composer.queue": "Queue",
  "composer.steer": "Send now",
  "composer.stop": "Stop",
  "composer.stopKey": "Stop ({key})",
  "composer.keys.label": "Keys",
  "composer.keys.send": "Send",
  "composer.keys.newline": "New line",
  "composer.keys.queue": "Queue",
  "composer.keys.steer": "Send now",
  "composer.keys.mention": "Mention a file",
  "composer.keys.command": "Commands",
  "composer.setting": "{setting}: {value}",

  // The commands that fit what is typed after a slash
  "composer.commands.label": "Commands",

  // The files and folders that fit what is typed after an @
  "composer.mentions.label": "Files and folders",
  "composer.mentions.empty": "No file or folder matches that.",

  // Messages sent while the agent works, waiting their turn
  "composer.queued.label": "Queued messages",
  "composer.queued.tag": "Queued",
  "composer.queued.edit": "Edit queued message: {preview}",
  "composer.queued.editShort": "Edit",
  "composer.queued.images": {
    one: "{count} image",
    other: "{count} images",
  },

  // The conversation: what the agent did, how a turn ended, what it is doing now
  "conversation.label": "Conversation",
  "conversation.loading": "Loading the conversation…",
  "conversation.empty": "Nothing here yet. Say something below.",
  "conversation.earlier": "Show earlier",
  "thought.label": "Thinking",
  "plan.label": "Plan",
  "tool.unnamed": "Tool",
  "tool.status.pending": "pending",
  "tool.status.in_progress": "in progress",
  "tool.status.paused": "paused",
  "tool.status.completed": "completed",
  "tool.status.failed": "failed",
  "tool.status.cancelled": "cancelled",
  "tool.verb.run.live": "Running",
  "tool.verb.run.done": "Ran",
  "tool.verb.read.live": "Reading",
  "tool.verb.read.done": "Read",
  "tool.verb.edit.live": "Editing",
  "tool.verb.edit.done": "Edited",
  "tool.verb.search.live": "Searching",
  "tool.verb.search.done": "Searched",
  "tool.verb.fetch.live": "Fetching",
  "tool.verb.fetch.done": "Fetched",
  "tool.verb.create.done": "Created",
  "tool.facts.added": "+{count}",
  "tool.facts.removed": "−{count}",
  "tool.facts.diff": "{added} lines added, {removed} removed",
  "tool.facts.staged": "held for review",
  "tool.facts.empty": "empty file",
  "tool.facts.lines": { one: "{count} line", other: "{count} lines" },
  "tool.facts.range": "lines {start}–{end}",
  "tool.facts.rangeOf": "lines {start}–{end} of {total}",
  "tool.facts.files": { one: "{count} file", other: "{count} files" },
  "tool.facts.filesMore": "{count}+ files",
  "tool.facts.matchesIn": { one: "{count} match in {files}", other: "{count} matches in {files}" },
  "tool.diff.add": "added",
  "tool.diff.del": "removed",
  "tool.diff.context": "unchanged",
  "tool.diff.more": { one: "{count} more line not shown", other: "{count} more lines not shown" },
  "tool.diff.tooLarge": "The change is too large to show here.",
  "work.summary.run": { one: "ran {count} command", other: "ran {count} commands" },
  "work.summary.read": { one: "read {count} file", other: "read {count} files" },
  "work.summary.edit": { one: "made {count} edit", other: "made {count} edits" },
  "work.summary.search": { one: "ran {count} search", other: "ran {count} searches" },
  "work.summary.fetch": { one: "fetched {count} page", other: "fetched {count} pages" },
  "work.summary.other": { one: "used {count} other tool", other: "used {count} other tools" },
  "work.failed": { one: "{count} failed", other: "{count} failed" },
  "work.running": "running",
  "work.done": "done",
  "work.unfinished": "not finished",
  "turn.end.error": "The turn failed.",
  "turn.end.errorWith": "The turn failed: {message}",
  "turn.end.cancelled": "Stopped before it finished.",
  "turn.end.maxTokens": "Stopped: the reply reached its length limit.",
  "turn.end.maxTurnRequests": "Stopped: the agent took too many steps.",
  "turn.end.refusal": "The agent declined to continue.",
  "turn.end.other": "Ended: {reason}",
  "step.approval": "Waiting for your answer",
  "step.thinking": "Thinking…",
  "step.working": "Working…",
  "step.run": "Running a command",
  "step.read": "Reading a file",
  "step.edit": "Editing a file",
  "step.search": "Searching",
  "step.fetch": "Fetching a page",
  "step.other": "Using {name}",
  "thinking.show": "Show thinking",
  "session.settings": "Session settings",

  // The session list
  "sessions.label": "Sessions",
  "sessions.listLabel": "Session list",
  "sessions.group.needsYou": "Needs you",
  "sessions.group.running": "Running",
  "sessions.group.today": "Today",
  "sessions.group.yesterday": "Yesterday",
  "sessions.group.earlier": "Earlier",
  "sessions.unavailable": "Connect to an environment to see its sessions.",
  "sessions.empty": "No sessions in this workspace yet.",
  "sessions.showArchived": "Show archived",
  "sessions.hideArchived": "Hide archived",
  "sidebar.newSession": "New session",
  // What a row says of its session, in words (the dot is its colour and shape)
  "mark.needsYou": "Needs you",
  "mark.running": "Running",
  "mark.background": "Background work is running",
  "mark.unread": "Unread",

  // Choosing a folder on another environment's machine, from the New session dialog
  "folders.title": "Choose a folder",
  "folders.path": "Folder",
  "folders.list": "Folders",
  "folders.up": "Up one level",
  "folders.home": "Home",
  "folders.hidden": "Show hidden folders",
  "folders.empty": "There are no folders here.",
  "folders.loading": "Reading the folder…",
  "folders.truncated": "Only the first {count} folders are shown.",
  "folders.choose": "Choose this folder",
  "folders.cancel": "Back",
  "folders.error": "This folder cannot be shown: {reason}",
  "folders.retry": "Try again",
  "newSession.browse": "Browse…",

  // Folder trust: whether a folder may run the commands its own settings name (docs/protocol.md §8)
  "trust.title": "Trust this folder?",
  "trust.description":
    "{environment} would run what this folder's own settings name: hooks, and the servers and helpers in .mcp.json. Trust it only if you trust what is in it. Folders inside it follow this choice.",
  "trust.startTrusted": "Trust and start",
  "trust.startUntrusted": "Start without trusting",
  "trust.back": "Back",
  "trust.confirm": "Trust folder",
  "trust.trust": "Trust this folder",
  "trust.untrust": "Stop trusting this folder",
  "trust.failed": "The answer could not be kept, so nothing was started: {reason}",
  // Connectors: MCP servers the daemon keeps for every agent (docs/protocol.md §14)
  "connectors.open": "Connectors",
  "connectors.title": "Connectors",
  "connectors.lead":
    "MCP servers every agent on {environment} can use. Cycle keeps their keys and sign-ins; agents never see them. A change reaches a session the next time its agent starts.",
  "connectors.environment": "Environment",
  "connectors.none":
    "No connected environment can keep connectors. Connect one, or update Cycle on it.",
  "connectors.loading": "Reading connectors…",
  "connectors.unreadable": "The connectors could not be read: {reason}",
  "connectors.retry": "Try again",
  "connectors.empty": "No connectors yet. Add an MCP server and every session can use it.",
  "connectors.add": "Add connector",
  "connectors.use": "Use {name} in sessions",
  "connectors.actions": "Actions for {name}",
  "connectors.edit": "Edit",
  "connectors.signIn": "Sign in",
  "connectors.signOut": "Sign out",
  "connectors.remove": "Remove",
  "connectors.waiting": "Finish signing in to {name} in your browser.",
  "connectors.stopWaiting": "Stop waiting",
  "connectors.signedIn": "Signed in to {name}.",
  "connectors.status.ready": "Ready",
  "connectors.status.needs_auth": "Needs sign-in",
  "connectors.status.disabled": "Off",
  "connectors.status.error": "Not working",
  "connectors.status.unreachable": "Cannot be reached",
  "connectors.status.auth_failed": "Sign-in no longer works",
  "connectors.status.spawn_failed": "Could not start",
  "connectors.status.protocol": "Does not answer as an MCP server",
  "connectors.removeTitle": "Remove {name}?",
  "connectors.removeDescription":
    "Its sign-in and keys are deleted for good. Sessions stop using it the next time their agent starts.",
  "connectors.removeConfirm": "Remove connector",
  "connectors.form.addTitle": "Add a connector",
  "connectors.form.editTitle": "Edit {name}",
  "connectors.form.name": "Name",
  "connectors.form.nameHint": "What agents call it: lowercase letters, digits, - and _.",
  "connectors.form.transport": "How Cycle reaches it",
  "connectors.form.transport.http": "Remote URL",
  "connectors.form.transport.stdio": "Local command",
  "connectors.form.url": "URL",
  "connectors.form.command": "Command",
  "connectors.form.args": "Arguments, one per line",
  "connectors.form.cwd": "Working folder",
  "connectors.form.cwdHint": "Leave empty to run it in the session's folder.",
  "connectors.form.auth": "Sign-in",
  "connectors.form.auth.none": "None",
  "connectors.form.auth.oauth": "OAuth",
  "connectors.form.clientId": "Client ID",
  "connectors.form.clientIdHint": "Only for a server that does not register apps itself.",
  "connectors.form.headers": "Headers",
  "connectors.form.env": "Environment variables",
  "connectors.form.secretsHint":
    "Kept by Cycle on {environment}. A value is never shown again; you can replace or remove it.",
  "connectors.form.secretSet": "{name} is set",
  "connectors.form.secretRemoving": "{name} is removed when you save",
  "connectors.form.secretRemove": "Remove {name}",
  "connectors.form.secretKeep": "Keep {name}",
  "connectors.form.secretName": "Secret name",
  "connectors.form.secretValue": "Secret value",
  "connectors.form.secretAdd": "Add value",
  "connectors.form.save": "Save connector",
  "connectors.form.create": "Add connector",
  "connectors.form.back": "Back",
  "connectors.problem.invalid_name": "Use 1 to 32 lowercase letters, digits, - or _.",
  "connectors.problem.reserved_header":
    "Cycle sets that header itself. Use another name, such as Authorization or X-Api-Key.",
  "connectors.problem.invalid_cwd": "The folder must be an absolute path on that machine.",
  "connectors.problem.name_taken": "Another connector already has this name.",
  "connectors.problem.insecure_url": "Use an https URL. Plain http is only for this machine.",
  "connectors.problem.state_mismatch":
    "The sign-in that came back is not the one Cycle started. Sign in again.",
  "connectors.problem.no_registration":
    "This server does not register apps itself. Enter a client ID, then sign in.",
  "connectors.problem.auth_rejected":
    "The server refused the sign-in. Try again, or check the client ID.",
  "connectors.problem.unreachable": "The server could not be reached from {environment}.",
  "connectors.problem.not_found": "This connector is gone. It may have been removed elsewhere.",
  "connectors.problem.invalid": "The daemon did not accept this connector. Check the fields.",
  "connectors.problem.unsupported": "Cycle on {environment} is too old to keep connectors.",
  "connectors.problem.failed": "It could not be done: {reason}",
  "common.cancel": "Cancel",
  "common.close": "Close",

  // The workspace switcher: a workspace is a folder on one environment
  "workspace.label": "Workspace",
  "workspace.switch": "Switch workspace",
  "workspace.none": "No workspace yet",
  "workspace.on": "On {environment}",
  "workspace.onState": "On {environment} · {state}",
  "workspace.elsewhere.needsYou": {
    one: "{count} session needs you",
    other: "{count} sessions need you",
  },
  "workspace.elsewhere.running": {
    one: "{count} session is running",
    other: "{count} sessions are running",
  },
  "workspace.elsewhere.background": {
    one: "{count} session has background work",
    other: "{count} sessions have background work",
  },
  "workspace.elsewhere.unread": {
    one: "{count} session is unread",
    other: "{count} sessions are unread",
  },
  "workspace.elsewhere.prefix": "In other workspaces: {what}",
  "sessions.showAll": {
    one: "Show {count} more session",
    other: "Show {count} more sessions",
  },

  // What a notification says when a session is not in front of the person
  "attention.needs-you": "Waiting for your answer",
  // Not "finished": the list does not say how the turn ended, and a turn that failed or was stopped is idle too.
  "attention.finished": "Waiting for your next message",
  "attention.stopped": "The agent stopped unexpectedly",

  // A setting the agent offers: the choice it suggests
  "config.recommended": "Recommended",
  // A session's setting the daemon has no record of yet: not today's default, which it may not have
  "config.notSet": "Not set",

  // The code colours choice
  "codeTheme.label": "Code colours",

  // The menu at the foot of the sidebar: what belongs to the app, not to a session or an environment
  "app.settings": "App settings",
  "app.checkForUpdates": "Check for updates",
  // A remote environment whose Cycle is too old for this app
  "daemon.tooOld": "Cycle on {environment} is {version}, too old for this app.",
  "daemon.update": "Update to {to}",
  "daemon.updating": "Updating…",
  "daemon.tryAgain": "Try again",
  "daemon.failed":
    "Could not update Cycle on {environment}: {error}. Run the command on that machine instead:",
  "daemon.byHand": "Run this on {environment}",
  "daemon.confirmTitle": "Update Cycle on {environment} to {to}?",
  "daemon.confirmBody":
    "Cycle on that machine is stopped and starts again as the new version. Sessions there that are working are interrupted.",
  "daemon.confirm": "Update",
  "app.analyticsOff": "Turn off usage statistics",
  "app.analyticsOn": "Turn on usage statistics",

  // Said once, the first time: what is counted, and that it can be turned off (docs/analytics.md)
  "analytics.notice":
    "Cycle counts which features are used, to improve them. It never sends what you write, your files, or their names. You can turn this off at any time in the settings menu at the bottom of the sidebar.",
  "analytics.turnOff": "Turn off",
  "analytics.keepOn": "Keep on",
} as const satisfies Messages;

export type MessageKey = keyof typeof enUS;
