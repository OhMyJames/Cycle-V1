import { RequestError } from "@cycle/acp";
import { CycleErrorCode } from "@cycle/protocol";

/** A JSON-RPC error the daemon answers with. */
export class RpcError extends RequestError {}

/** JSON-RPC's own "Invalid params". */
export const INVALID_PARAMS = -32602;
/** ACP's "Resource not found", with `SessionNotFoundErrorData`. */
export const RESOURCE_NOT_FOUND = -32002;
/** ACP's "Unsupported protocol version". */
export const UNSUPPORTED_VERSION = -32022;

export const logUnavailable = (sessionId: string, detail: string): RpcError =>
  new RpcError(CycleErrorCode.LogUnavailable, "The session's history cannot be read or written", {
    sessionId,
    detail,
  });

export const sessionNotFound = (sessionId: string): RpcError =>
  new RpcError(RESOURCE_NOT_FOUND, "Session not found", { sessionId });

export const sessionBusy = (sessionId: string): RpcError =>
  new RpcError(CycleErrorCode.SessionBusy, "The session is working", { sessionId });
