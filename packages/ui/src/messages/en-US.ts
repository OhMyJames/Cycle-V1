// The source language of the interface. Add a key here first; a translation is a file beside this one with the same keys.
// Keys are named by where the text is (`search.placeholder`), not by what it says, so that rewording does not rename them.
// Write whole sentences. Never build one from pieces (`"Delete " + name`): other languages order the words differently.
// A number of things is a plural message with `count`; a name or a path is a `{placeholder}`.
import type { Messages } from "../i18n.ts";

export const enUS = {
  // The session search (Cmd+K)
  "search.label": "Search sessions",
  "search.placeholder": "Search sessions by title, folder, agent or host",
  "search.empty": "No session matches that.",
  "search.group.actions": "Actions",
  "search.action.newSession": "New session",
  "search.on": "on {host}",
  "search.archived": "archived",
  "search.open": "Search sessions",

  // Images in a conversation
  "image.open": "Open image: {name}",
  "image.alt.agent": "Image from the agent",
  "image.alt.user": "Image you sent",
  "image.close": "Close",
  "image.unsupported": "An image that cannot be shown ({type})",
  "image.tooLarge": "An image too large to show ({size})",

  // Attaching images to a message
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

  // The session list
  "sessions.label": "Sessions",
  "sessions.listLabel": "Session list",
  "sessions.noFolder": "No folder",
  "sessions.group.needsYou": "Needs you",
  "sessions.group.working": "Working",
  "sessions.showAll": {
    one: "Show {count} more session",
    other: "Show {count} more sessions",
  },

  // What a notification says when a session is not in front of the person
  "attention.needs-you": "Waiting for your answer",
  // Not "finished": the list does not say how the turn ended, and a turn that failed or was stopped is idle too.
  "attention.finished": "Waiting for your next message",
  "attention.stopped": "The agent stopped unexpectedly",

  // The code colours choice
  "codeTheme.label": "Code colours",
} as const satisfies Messages;

export type MessageKey = keyof typeof enUS;
