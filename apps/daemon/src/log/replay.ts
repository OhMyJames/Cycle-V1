import { INVALID_PARAMS, RpcError } from "../errors.ts";
import type { LogRecord, SessionLog } from "./types.ts";

/**
 * Sends a client the records after `after`, then every later one, in seq order, none twice and none
 * missed, though records are being appended while it runs (docs/protocol.md §7).
 *
 * The order of the steps is what makes that so: subscribe first, so that nothing appended from here
 * on is lost; note the last seq written; read up to it from the file; then send what was held back,
 * but only what is past that point. `send` is awaited, so a slow client slows only itself.
 *
 * Resolves when the replay is done and the client is live. The returned function ends the live part.
 */
export const attach = async (
  log: SessionLog,
  after: number,
  send: (record: LogRecord) => void | Promise<void>,
  /**
   * Runs once the history has been sent and before the client is live, with the last seq sent.
   * What it sends comes after the replay and before any live record.
   */
  beforeLive?: (replayedTo: number) => void | Promise<void>,
): Promise<{ replayedTo: number; detach: () => void }> => {
  if (!Number.isInteger(after) || after < 0 || after > log.lastSeq()) {
    throw new RpcError(INVALID_PARAMS, "Nothing at that point in the session's history", {
      sessionId: log.sessionId,
      after,
      lastSeq: log.lastSeq(),
    });
  }
  let live = false;
  const held: LogRecord[] = [];
  let sent = after;
  let failure: unknown;

  const unsubscribe = log.subscribe((record) => {
    if (!live) held.push(record);
    else
      void Promise.resolve(send(record)).catch((error) => {
        failure = error;
      });
  });

  try {
    const upTo = log.lastSeq();
    for (const record of await log.read({ after, upTo })) {
      await send(record);
      sent = record.seq;
    }
    const drain = async () => {
      while (held.length > 0) {
        const record = held.shift() as LogRecord;
        if (record.seq > sent) {
          await send(record);
          sent = record.seq;
        }
      }
    };
    // What it is told is the seq sent so far, so what was held up to then goes out first.
    if (beforeLive) {
      await drain();
      await beforeLive(sent);
    }
    // The last of what was held goes out, and the client is live in the same step that finds nothing
    // left: with an await between the two, a record appended there would be held and never sent.
    for (;;) {
      const record = held.shift();
      if (record === undefined) {
        live = true;
        break;
      }
      if (record.seq > sent) {
        await send(record);
        sent = record.seq;
      }
    }
  } catch (error) {
    unsubscribe();
    throw error;
  }
  if (failure !== undefined) {
    unsubscribe();
    throw failure;
  }
  return { replayedTo: sent, detach: unsubscribe };
};
