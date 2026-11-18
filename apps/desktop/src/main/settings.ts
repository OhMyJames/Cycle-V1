import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  // This computer is the one "local" there is: another entry that says it is local would be a second way into the same daemon.
  if (entry.kind === "local")
    return id === LOCAL_ENVIRONMENT.id ? { id, name, kind: "local" } : undefined;
  if (entry.kind === "remote" && isRecord(entry.transport) && entry.transport.type === "ssh") {
    const { host } = entry.transport;
    const command = strings(entry.transport.command);
    // A command that is not a list of words is not one to run by guessing: the entry is left as it is.
    if (
      typeof host !== "string" ||
      (entry.transport.command !== undefined && command === undefined)
    )
      return undefined;
    return {
      id,
      name,
      kind: "remote",
      transport: { type: "ssh", host, ...(command !== undefined ? { command } : {}) },
    };
  }
  if (entry.kind === "ssh" && typeof entry.host === "string") {
    const command = strings(entry.command);
    if (entry.command !== undefined && command === undefined) return undefined;
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
 * Settings in a JSON file in the app's data directory, written whole and renamed into place. What this version does not
 * understand is not shown and not lost: an entry it cannot read (a newer app wrote it, or it is damaged), the fields it
 * does not know of in an entry it can, and any other key of the file are written back as they were.
 */
export const fileSettings = (path: string): Settings => {
  let unknown: unknown[] = [];
  let rest: Record<string, unknown> = {};
  // What each environment was in the file, to write back what it has no field for.
  const raw = new Map<string, Record<string, unknown>>();
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
        const record = isRecord(parsed) ? parsed : {};
        // `environments` is the format; `hosts` is the one before it, read when there is no `environments`.
        const entries = Array.isArray(record.environments)
          ? record.environments
          : Array.isArray(record.hosts)
            ? record.hosts
            : [];
        const { environments: _environments, hosts: _hosts, ...others } = record;
        rest = others;
        const known: EnvironmentConfig[] = [];
        unknown = [];
        raw.clear();
        for (const entry of entries) {
          const environment = environmentOf(entry);
          if (environment === undefined) unknown.push(entry);
          else if (environment.id !== LOCAL_ENVIRONMENT.id) {
            known.push(environment);
            if (isRecord(entry)) raw.set(environment.id, entry);
          }
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
      const saved = environments.filter((e) => e.id !== LOCAL_ENVIRONMENT.id);
      const ids = new Set(saved.map((e) => e.id));
      const written = [
        // As it was in the file, with its fields we do not know, when it has not changed; else as it is now.
        ...saved.map((e) => {
          const before = raw.get(e.id);
          // Only an entry already in the new format: the older one has other field names, which are not written again.
          return before?.kind === e.kind && isDeepStrictEqual(environmentOf(before), e)
            ? before
            : e;
        }),
        // An entry with the id of one that is saved now would be two of one: the one the person saved wins.
        ...unknown.filter((u) => !(isRecord(u) && typeof u.id === "string" && ids.has(u.id))),
      ];
      await writeFile(
        temporary,
        `${JSON.stringify({ ...rest, environments: written }, null, 2)}\n`,
      );
      await rename(temporary, path);
    },
  };
};
