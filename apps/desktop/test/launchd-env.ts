/**
 * Environment for an app that `open` starts, which does not get this process's: launchd's is where it
 * can be set, and launchd's is the whole login session's. So what was there is put back, whatever the
 * test did, and a value that was already set is set again and not removed. A test that is killed outright
 * (SIGKILL) cannot put anything back: then the login session keeps CYCLE_HOME and CYCLE_UPDATE_URL until
 * `launchctl unsetenv` or the next login.
 */
export type Launchctl = (args: string[]) => string;

/** Sets the variables; the function it returns puts launchd's environment back as it was. */
export const setLaunchdEnv = (launchctl: Launchctl, vars: Record<string, string>): (() => void) => {
  // A value that could not be read is not known to be absent: it is left as it is, not removed.
  const before = new Map<string, string>();
  for (const key of Object.keys(vars)) before.set(key, launchctl(["getenv", key]).trim());
  const restore = () => {
    for (const [key, value] of before) {
      try {
        launchctl(value === "" ? ["unsetenv", key] : ["setenv", key, value]);
      } catch {}
    }
  };
  try {
    for (const [key, value] of Object.entries(vars)) launchctl(["setenv", key, value]);
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
};

export const withLaunchdEnv = async <T>(
  launchctl: Launchctl,
  vars: Record<string, string>,
  body: () => Promise<T>,
): Promise<T> => {
  const restore = setLaunchdEnv(launchctl, vars);
  try {
    return await body();
  } finally {
    restore();
  }
};
