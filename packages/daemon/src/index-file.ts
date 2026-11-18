import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/** One session as the daemon records it. The history itself is in the session's log. */
export const SessionEntrySchema = z.object({
  agent: z.string(),
  /** The id the agent knows the session by. The same as the session's id when the agent adopted it. */
  agentSessionId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  archived: z.boolean().optional(),
  /** What was asked of the agent with `session/set_config_option`, applied again when it is restarted. */
  config: z.record(z.string(), z.string()).optional(),
  createdAt: z.string(),
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

const IndexSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), SessionEntrySchema),
});

/** The index is there but cannot be read. It is not replaced: it cannot be rebuilt. */
export class IndexUnreadableError extends Error {
  constructor(path: string, detail: string) {
    super(
      `The session index at ${path} cannot be read (${detail}). Fix or move it; it is not replaced.`,
    );
    this.name = "IndexUnreadableError";
  }
}

/**
 * Which sessions are Cycle's, and what the daemon knows of each (decision 0006). Kept apart from
 * the logs so that listing does not scan them. Written whole, to a temporary file that is then
 * renamed over the old one, so a crash leaves the old index or the new one and never half of one.
 */
export class SessionIndex {
  readonly #path: string;
  #sessions: Map<string, SessionEntry>;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, sessions: Map<string, SessionEntry>) {
    this.#path = path;
    this.#sessions = sessions;
  }

  static async load(path: string): Promise<SessionIndex> {
    const file = Bun.file(path);
    if (!(await file.exists())) return new SessionIndex(path, new Map());
    let parsed: z.infer<typeof IndexSchema>;
    try {
      parsed = IndexSchema.parse(JSON.parse(await file.text()));
    } catch (error) {
      throw new IndexUnreadableError(path, error instanceof Error ? error.message : String(error));
    }
    return new SessionIndex(path, new Map(Object.entries(parsed.sessions)));
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.#sessions.get(sessionId);
  }

  list(): [string, SessionEntry][] {
    return [...this.#sessions.entries()];
  }

  put(sessionId: string, entry: SessionEntry): Promise<void> {
    return this.#change(() => this.#sessions.set(sessionId, SessionEntrySchema.parse(entry)));
  }

  update(sessionId: string, change: Partial<SessionEntry>): Promise<void> {
    return this.#change(() => {
      const entry = this.#sessions.get(sessionId);
      if (entry === undefined) throw new Error(`No session ${sessionId} in the index`);
      this.#sessions.set(sessionId, SessionEntrySchema.parse({ ...entry, ...change }));
    });
  }

  delete(sessionId: string): Promise<void> {
    return this.#change(() => this.#sessions.delete(sessionId));
  }

  #change(apply: () => void): Promise<void> {
    const run = this.#queue.then(async () => {
      const before = new Map(this.#sessions);
      try {
        apply();
        await this.#save();
      } catch (error) {
        this.#sessions = before;
        throw error;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    const body = { version: 1, sessions: Object.fromEntries(this.#sessions) };
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`);
    await rename(temporary, this.#path);
  }
}
