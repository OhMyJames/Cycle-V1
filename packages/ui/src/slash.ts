// The commands an agent offers, typed as `/name` at the very start of a message. Pure TypeScript.
import type { Command } from "./model/index.ts";

/**
 * The query of a command being typed, or undefined when none is. Only at the very start of the message, because a slash
 * later on is a path or a fraction, and only until the first space, because what follows is the command's own input.
 * `before` is the first block's text up to the caret, and `first` says the caret is in the first block.
 */
export const slashQuery = (before: string, first: boolean): string | undefined => {
  if (!first || !before.startsWith("/")) return undefined;
  const typed = before.slice(1);
  return /\s/.test(typed) ? undefined : typed;
};

/** The commands that fit a query: names that start with it first, then names that hold it. Case does not matter. */
export const filterCommands = (commands: readonly Command[], query: string): Command[] => {
  const lower = query.toLowerCase();
  const name = (command: Command) => command.name.toLowerCase();
  return [
    ...commands.filter((command) => name(command).startsWith(lower)),
    ...commands.filter(
      (command) => !name(command).startsWith(lower) && name(command).includes(lower),
    ),
  ];
};

/** What choosing a command puts in the message in place of what was typed of it. */
export const commandText = (command: Command): string => `/${command.name} `;
