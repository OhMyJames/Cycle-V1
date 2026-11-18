import { CycleErrorCode } from "@cycle/protocol";

/** A JSON-RPC error the daemon answers with. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** JSON-RPC's own "Invalid params". */
export const INVALID_PARAMS = -32602;

export const logUnavailable = (sessionId: string, detail: string): RpcError =>
  new RpcError(CycleErrorCode.LogUnavailable, "The session's history cannot be read or written", {
    sessionId,
    detail,
  });
