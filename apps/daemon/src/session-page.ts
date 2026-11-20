import { META, SessionPageSchema } from "@cycle/protocol";
import { INVALID_PARAMS, RpcError } from "./errors.ts";
import {
  comparePosition,
  type SessionEntry,
  type SessionIndex,
  type SessionPosition,
} from "./index-file.ts";

type Entry = [string, SessionEntry];
const decode = (cursor: string): SessionPosition => {
  try {
    const bytes = Buffer.from(cursor, "base64url");
    const key = JSON.parse(bytes.toString("utf8"));
    if (
      bytes.toString("base64url") === cursor &&
      Array.isArray(key) &&
      key.length === 2 &&
      typeof key[0] === "string" &&
      typeof key[1] === "string"
    )
      return [key[0], key[1]];
  } catch {}
  throw new RpcError(INVALID_PARAMS, "Invalid session list cursor");
};

/** Bound the number of logs opened even when every row in this page turns out to be hidden. */
export const sessionPage = (
  index: SessionIndex,
  params: { cwd?: string | null; cursor?: string | null; _meta?: Record<string, unknown> | null },
): { entries: Entry[]; nextCursor?: string } => {
  const raw = params._meta?.[META.page];
  if (raw === undefined && params.cursor == null) {
    const entries = index.list();
    return {
      entries: params.cwd == null ? entries : entries.filter(([, e]) => e.cwd === params.cwd),
    };
  }
  const options = SessionPageSchema.safeParse(raw);
  if (!options.success) throw new RpcError(INVALID_PARAMS, "Invalid session list page options");
  const { limit, agent, createdFrom, createdBefore } = options.data;
  const from = createdFrom && new Date(createdFrom).toISOString();
  const before = createdBefore && new Date(createdBefore).toISOString();
  const after = params.cursor == null ? undefined : decode(params.cursor);
  const order = index.createdOrder();
  let start = 0;
  if (after !== undefined) {
    let end = order.length;
    while (start < end) {
      const mid = Math.floor((start + end) / 2);
      const key = order[mid];
      if (key && comparePosition(key, after) <= 0) start = mid + 1;
      else end = mid;
    }
  }
  const entries: Entry[] = [];
  let last: SessionPosition | undefined;
  for (let i = start; i < order.length; i++) {
    const key = order[i];
    if (!key) continue;
    const [createdAt, id] = key;
    if (from && createdAt < from) break;
    if (before && createdAt >= before) continue;
    const e = index.get(id);
    if (
      !e ||
      (agent !== undefined && e.agent !== agent) ||
      (params.cwd != null && e.cwd !== params.cwd)
    )
      continue;
    if (entries.length === limit && last)
      return { entries, nextCursor: Buffer.from(JSON.stringify(last)).toString("base64url") };
    entries.push([id, e]);
    last = key;
  }
  return { entries };
};
