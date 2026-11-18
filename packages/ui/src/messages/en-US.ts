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

  // The box a message is written in
  "composer.message": "Message",
  "composer.placeholder.idle": "Message the agent",
  "composer.placeholder.working": "Queue a message for when the agent is done",
  "composer.placeholder.none": "Choose or start a session",
  "composer.send": "Send",
  "composer.queue": "Queue",
  "composer.stop": "Stop",

  // The commands that fit what is typed after a slash
  "composer.commands.label": "Commands",

  // Messages sent while the agent works, waiting their turn
  "composer.queued.label": "Queued messages",
  "composer.queued.tag": "Queued",
  "composer.queued.edit": "Edit queued message: {preview}",
  "composer.queued.editShort": "Edit",
  "composer.queued.images": {
    one: "{count} image",
    other: "{count} images",
  },

  // The code colours choice
  "codeTheme.label": "Code colours",
} as const satisfies Messages;

export type MessageKey = keyof typeof enUS;
