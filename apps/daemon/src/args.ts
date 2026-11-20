import { parseArgs } from "node:util";

/** The commands that hand the rest of the line to Claude, which has options of its own. */
const FORWARDING = ["login", "claude"];

/** Cycle's own options: the one table both the scan for the command and the parse are read from. */
const OPTIONS = {
  "data-dir": { type: "string" },
  socket: { type: "string" },
  help: { type: "boolean" },
  /** `stop`: stop even when sessions are working, interrupting them. */
  force: { type: "boolean" },
  /** `stop`: wait until no session is working, then stop. */
  wait: { type: "boolean" },
} as const;
const WITH_VALUE = Object.entries(OPTIONS)
  .filter(([, option]) => option.type === "string")
  .map(([name]) => `--${name}`);

/**
 * Cycle's options, and what follows the command. For the commands that run Claude, everything
 * after the command word is Claude's, as it was typed (`--version`, `-p`, `--`, a value that looks
 * like an option): Cycle's options are read only before it.
 */
export const parseCli = (argv: string[]) => {
  let own = argv;
  let forwarded: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (WITH_VALUE.includes(arg)) i++;
    else if (!arg.startsWith("-")) {
      if (FORWARDING.includes(arg)) {
        own = argv.slice(0, i + 1);
        forwarded = argv.slice(i + 1);
      }
      break;
    }
  }
  const { values, positionals } = parseArgs({
    args: own,
    options: OPTIONS,
    allowPositionals: true,
  });
  return { values, positionals, forwarded };
};
