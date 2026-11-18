import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostConfig } from "@cycle/ui";

export const LOCAL_HOST: HostConfig = { id: "local", name: "This computer", kind: "local" };

/** Where the app keeps what the user set up. */
export type Settings = {
  load(): Promise<HostConfig[]>;
  save(hosts: HostConfig[]): Promise<void>;
};

/** Settings in a JSON file in the app's data directory, written whole and renamed into place. */
export const fileSettings = (path: string): Settings => ({
  async load() {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { hosts?: HostConfig[] };
      const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : [];
      // The local daemon is always there, and always first.
      return [LOCAL_HOST, ...hosts.filter((h) => h.id !== LOCAL_HOST.id)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [LOCAL_HOST];
      throw new Error(`${path} cannot be read: ${error instanceof Error ? error.message : error}`);
    }
  },
  async save(hosts) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ hosts: hosts.filter((h) => h.id !== LOCAL_HOST.id) }, null, 2)}\n`,
    );
    await rename(temporary, path);
  },
});
