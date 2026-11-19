import { parseArgs } from "node:util";

/** The commands that hand the rest of the line to Claude, which has options of its own. */
const FORWARDING = ["login", "claude"];
const WITH_VALUE = ["--data-dir", "--socket"];

/**
 * Cycle's own options, and what follows the command. For the commands that run Claude, everything
 * after the command word is Claude's, as it was typed (`--version`, `-p`, `--`, a value that looks
 * like an option): Cycle's options are read only before it.
 */
export const parseCli = (argv: string[]) => {
  let command: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (WITH_VALUE.includes(arg)) i++;
    else if (!arg.startsWith("-")) {
      command = i;
      break;
    }
  }
  const forwarded =
    command !== undefined && FORWARDING.includes(argv[command] as string)
      ? argv.slice(command + 1)
      : undefined;
  const own = forwarded === undefined ? argv : argv.slice(0, (command as number) + 1);
  const { values, positionals } = parseArgs({
    args: own,
    options: {
      "data-dir": { type: "string" },
      socket: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });
  return { values, positionals, forwarded };
};
