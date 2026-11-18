import { dirname, join } from "node:path";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

/** True in the single-file executable `bun build --compile` makes: its code is inside it. */
export const compiled = (): boolean => Bun.main.startsWith("/$bunfs");

/** The command that runs this program again: the executable itself, or `bun main.ts` from source. */
export const selfCommand = (): string[] => (compiled() ? [process.execPath] : ["bun", MAIN]);

/**
 * The Claude Code binary the SDK drives. In the executable it cannot find its own platform package,
 * so the binary is shipped beside it (see scripts/build-daemon.ts). From source the SDK finds it.
 */
export const claudeExecutable = (): string | undefined =>
  compiled() ? join(dirname(process.execPath), "claude") : undefined;
