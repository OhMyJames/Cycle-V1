import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EnvironmentConfig } from "@cycle/ui";

export const LOCAL_ENVIRONMENT: EnvironmentConfig = {
  id: "local",
  name: "This computer",
  kind: "local",
};

/** Where the app keeps what the user set up. */
export type Settings = {
  load(): Promise<EnvironmentConfig[]>;
  save(environments: EnvironmentConfig[]): Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;

/**
 * One entry of the file as an environment, or undefined when it is not one this app understands. The format before
 * "environment" was a list of `hosts`, each `{ id, name, kind: "ssh", host, command? }`: it is read as a remote one
 * reached over SSH, with the same id (the id is what the sessions and drafts are known by).
 */
export const environmentOf = (entry: unknown): EnvironmentConfig | undefined => {
  if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string")
    return undefined;
  const { id, name } = entry;
  if (entry.kind === "local") return { id, name, kind: "local" };
  if (entry.kind === "remote" && isRecord(entry.transport) && entry.transport.type === "ssh") {
    const { host } = entry.transport;
    const command = strings(entry.transport.command);
    if (typeof host !== "string") return undefined;
    return {
      id,
      name,
      kind: "remote",
      transport: { type: "ssh", host, ...(command !== undefined ? { command } : {}) },
    };
  }
  if (entry.kind === "ssh" && typeof entry.host === "string") {
    const command = strings(entry.command);
    return {
      id,
      name,
      kind: "remote",
      transport: { type: "ssh", host: entry.host, ...(command !== undefined ? { command } : {}) },
    };
  }
  return undefined;
};

/**
 * Settings in a JSON file in the app's data directory, written whole and renamed into place. An entry that this
 * version does not understand (a newer app wrote it) is not shown and not dropped: it is written back as it was.
 */
export const fileSettings = (path: string): Settings => {
  let unknown: unknown[] = [];
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
        const record = isRecord(parsed) ? parsed : {};
        // `environments` is the format; `environments` is the one before it, read when there is no `environments`.
        const entries = Array.isArray(record.environments)
          ? record.environments
          : Array.isArray(record.hosts)
            ? record.hosts
            : [];
        const known: EnvironmentConfig[] = [];
        unknown = [];
        for (const entry of entries) {
          const environment = environmentOf(entry);
          if (environment === undefined) unknown.push(entry);
          else if (environment.id !== LOCAL_ENVIRONMENT.id) known.push(environment);
        }
        // The local daemon is always there, and always first.
        return [LOCAL_ENVIRONMENT, ...known];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [LOCAL_ENVIRONMENT];
        throw new Error(
          `${path} cannot be read: ${error instanceof Error ? error.message : error}`,
        );
      }
    },
    async save(environments) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      const written = [...environments.filter((e) => e.id !== LOCAL_ENVIRONMENT.id), ...unknown];
      await writeFile(temporary, `${JSON.stringify({ environments: written }, null, 2)}\n`);
      await rename(temporary, path);
    },
  };
};
