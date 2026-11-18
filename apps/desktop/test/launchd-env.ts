/**
 * Environment for an app that `open` starts, which does not get this process's: launchd's is where it
 * can be set, and launchd's is the whole login session's. So what was there is put back, whatever the
 * test did, and a value that was already set is set again and not removed.
 */
export type Launchctl = (args: string[]) => string;

/** Sets the variables; the function it returns puts launchd's environment back as it was. */
export const setLaunchdEnv = (launchctl: Launchctl, vars: Record<string, string>): (() => void) => {
  const before = new Map<string, string>();
  for (const key of Object.keys(vars)) {
    let value = "";
    try {
      value = launchctl(["getenv", key]).trim();
    } catch {}
    before.set(key, value);
  }
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
