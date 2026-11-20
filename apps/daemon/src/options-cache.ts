import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const CachedChoiceSchema = z.object({
  const: z.string(),
  title: z.string(),
  description: z.string().optional(),
});

export type CachedChoice = z.infer<typeof CachedChoiceSchema>;

const OptionsCacheSchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), z.record(z.string(), z.array(CachedChoiceSchema))),
});

/**
 * Disk-backed cache of dynamically discovered agent choices (such as the model catalog reported by Claude's
 * `initializationResult().models`). Pure cache: a missing or corrupt file falls back to the static schema rather
 * than blocking daemon startup.
 */
export class AgentOptionsCache {
  readonly #path: string;
  #agents: Map<string, Record<string, CachedChoice[]>>;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, agents: Map<string, Record<string, CachedChoice[]>>) {
    this.#path = path;
    this.#agents = agents;
  }

  static async load(path: string): Promise<AgentOptionsCache> {
    const file = Bun.file(path);
    if (!(await file.exists())) return new AgentOptionsCache(path, new Map());
    try {
      const parsed = OptionsCacheSchema.parse(JSON.parse(await file.text()));
      return new AgentOptionsCache(path, new Map(Object.entries(parsed.agents)));
    } catch {
      return new AgentOptionsCache(path, new Map());
    }
  }

  /** Overlays cached dynamic choices onto an agent's static `configSchema`, preserving defaults and `_meta`. */
  apply(agent: string, schema: Record<string, unknown>): Record<string, unknown> {
    const cached = this.#agents.get(agent);
    if (cached === undefined) return schema;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties === undefined || typeof properties !== "object") return schema;
    let changed = false;
    const nextProperties: Record<string, Record<string, unknown>> = { ...properties };
    for (const [configId, choices] of Object.entries(cached)) {
      const existing = properties[configId];
      if (existing === undefined || choices.length === 0) continue;
      nextProperties[configId] = {
        ...existing,
        oneOf: choices.map((c) => ({
          const: c.const,
          title: c.title,
          ...(c.description !== undefined ? { description: c.description } : {}),
        })),
      };
      changed = true;
    }
    return changed ? { ...schema, properties: nextProperties } : schema;
  }

  update(agent: string, configId: string, choices: readonly CachedChoice[]): Promise<void> {
    if (choices.length === 0) return Promise.resolve();
    const normalized: CachedChoice[] = choices.map((c) => ({
      const: c.const,
      title: c.title,
      ...(c.description !== undefined && c.description !== ""
        ? { description: c.description }
        : {}),
    }));
    const run = this.#queue.then(async () => {
      const previousAgent = this.#agents.get(agent);
      const current = previousAgent?.[configId];
      if (current !== undefined && JSON.stringify(current) === JSON.stringify(normalized)) {
        return;
      }
      this.#agents.set(agent, { ...(previousAgent ?? {}), [configId]: normalized });
      const snapshot = JSON.stringify(
        { version: 1, agents: Object.fromEntries(this.#agents) },
        null,
        2,
      );
      try {
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        const temporary = `${this.#path}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
        await rename(temporary, this.#path);
      } catch (error) {
        if (previousAgent === undefined) this.#agents.delete(agent);
        else this.#agents.set(agent, previousAgent);
        throw error;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Waits for any in-flight cache writes to finish before daemon shutdown. */
  flush(): Promise<void> {
    return this.#queue.then(() => undefined);
  }
}

/** Extracts cacheable choice entries for a specific `configId` from an ACP `configOptions` array. */
export const choicesFromConfigOptions = (
  options: unknown,
  configId: string,
): CachedChoice[] | undefined => {
  if (!Array.isArray(options)) return undefined;
  const entry = options.find(
    (item): item is { configId?: unknown; options?: unknown } =>
      typeof item === "object" &&
      item !== null &&
      (item as { configId?: unknown }).configId === configId,
  );
  if (!Array.isArray(entry?.options)) return undefined;
  const out: CachedChoice[] = [];
  for (const choice of entry.options) {
    if (typeof choice !== "object" || choice === null) continue;
    const c = choice as {
      value?: unknown;
      name?: unknown;
      description?: unknown;
      _meta?: Record<string, unknown>;
    };
    if (c._meta?.["cycle/custom"] === true) continue;
    if (typeof c.value !== "string" || c.value === "") continue;
    out.push({
      const: c.value,
      title: typeof c.name === "string" && c.name !== "" ? c.name : c.value,
      ...(typeof c.description === "string" && c.description !== ""
        ? { description: c.description }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
};
