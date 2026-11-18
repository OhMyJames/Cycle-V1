import { join } from "node:path";

/** Where a development run (`bun run start`, not an installed app) keeps its data when nothing says otherwise. */
export const DEV_HOME = ".cycle-dev";

/**
 * The data directory the local daemon is told to use, or undefined to leave it to the daemon's own
 * default (`~/.cycle`, the installed app's).
 *
 * A run from source has to be unable to reach the installed app's daemon, socket and sessions by
 * accident: with no `CYCLE_HOME` both would be `~/.cycle`, and starting the app from a checkout
 * would attach to, or stop, the daemon the person's real work is running in. `CYCLE_HOME` still
 * wins when it is set, for either.
 */
export const localHome = (options: {
  packaged: boolean;
  env: Record<string, string | undefined>;
  home: string;
}): string | undefined => {
  const chosen = options.env.CYCLE_HOME;
  if (chosen !== undefined && chosen !== "") return chosen;
  return options.packaged ? undefined : join(options.home, DEV_HOME);
};
