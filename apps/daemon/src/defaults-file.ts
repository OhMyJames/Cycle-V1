import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const DefaultsSchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), z.record(z.string(), z.string())),
});

/** The defaults file is there but cannot be read. It is not replaced. */
export class DefaultsUnreadableError extends Error {
  constructor(path: string, detail: string) {
    super(
      `The agent defaults at ${path} cannot be read (${detail}). Fix or move it; it is not replaced.`,
    );
    this.name = "DefaultsUnreadableError";
  }
}

/**
 * What a new session of an agent starts with (docs/protocol.md §10): per agent, settings by name.
 * A session's own configuration, given when it is created, wins over these. Written whole, to a
 * temporary file and then renamed, like the session index.
 */
export class AgentDefaults {
  readonly #path: string;
  #agents: Map<string, Record<string, string>>;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, agents: Map<string, Record<string, string>>) {
    this.#path = path;
    this.#agents = agents;
  }

  static async load(path: string): Promise<AgentDefaults> {
    const file = Bun.file(path);
    if (!(await file.exists())) return new AgentDefaults(path, new Map());
    try {
      const parsed = DefaultsSchema.parse(JSON.parse(await file.text()));
      return new AgentDefaults(path, new Map(Object.entries(parsed.agents)));
    } catch (error) {
      throw new DefaultsUnreadableError(
        path,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  get(agent: string): Record<string, string> {
    return { ...(this.#agents.get(agent) ?? {}) };
  }

  set(agent: string, config: Record<string, string>): Promise<void> {
    const run = this.#queue.then(async () => {
      const before = new Map(this.#agents);
      try {
        if (Object.keys(config).length === 0) this.#agents.delete(agent);
        else this.#agents.set(agent, { ...config });
        await mkdir(dirname(this.#path), { recursive: true });
        const temporary = `${this.#path}.${process.pid}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify({ version: 1, agents: Object.fromEntries(this.#agents) }, null, 2)}\n`,
        );
        await rename(temporary, this.#path);
      } catch (error) {
        this.#agents = before;
        throw error;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
