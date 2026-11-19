import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** In `session/new` and `session/resume`: whether the folder may run its own configuration's commands (`META.trusted`). */
export const TRUSTED = "cycle/trusted";

/** The daemon's decision for the session's folder, if it sent one. */
export const trustOf = (meta: unknown): boolean | undefined => {
  const value = (meta as Record<string, unknown> | null | undefined)?.[TRUSTED];
  return typeof value === "boolean" ? value : undefined;
};

/** Where Claude keeps what it knows of folders: `.claude.json` in its config directory. */
export const claudeJsonPath = (env: Record<string, string>): string | undefined => {
  const dir = env.CLAUDE_CONFIG_DIR ?? env.HOME;
  return dir === undefined ? undefined : join(dir, ".claude.json");
};

/**
 * Puts the daemon's decision where Claude looks for it before it runs a folder's own commands
 * (`headersHelper`, hooks): `projects[cwd].hasTrustDialogAccepted` in `.claude.json`. The SDK has
 * no option for it and shows no dialog (docs/adapters/claude.md "文件夹信任"). Under `cwd` and, when
 * it differs, its real path. Written only when it differs from what is there, as the whole file
 * read plus this, to a temporary file and then renamed: the Claude processes write it too. A file
 * that is there and is not JSON is left alone. Returns why nothing was written, if it could not be.
 */
export const recordTrust = (
  file: string,
  cwd: string,
  trusted: boolean,
): "written" | "unchanged" | { failed: string } => {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof config !== "object" || config === null || Array.isArray(config))
      return { failed: `${file} is not a JSON object` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { failed: error instanceof Error ? error.message : String(error) };
    config = {};
  }
  const paths = new Set([cwd]);
  try {
    paths.add(realpathSync(cwd));
  } catch {
    // A folder that is gone: Claude will not start in it either.
  }
  const projects = { ...((config.projects as Record<string, unknown> | undefined) ?? {}) };
  let changed = false;
  for (const path of paths) {
    const project = (projects[path] as Record<string, unknown> | undefined) ?? {};
    if (project.hasTrustDialogAccepted === trusted) continue;
    projects[path] = { ...project, hasTrustDialogAccepted: trusted };
    changed = true;
  }
  if (!changed) return "unchanged";
  try {
    // Before Claude has ever run, its config directory is not there yet.
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.cycle-${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...config, projects }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, file);
    return "written";
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
};
