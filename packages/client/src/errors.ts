/**
 * Client-side errors — daemon이 보낸 JSON-RPC 에러를 호출자에게 다시 throw.
 *
 * `BlockedError`는 muxd core/errors.ts와 인터페이스 호환 — 사용자가 client만
 * 의존해도 같은 try/catch 코드가 동작.
 */

export type ClientErrorCode =
  | "BLOCKED"
  | "SESSION_NOT_FOUND"
  | "SESSION_DEAD"
  | "TIMEOUT"
  | "PTY_SPAWN_FAILED"
  | "CLAUDE_NOT_FOUND"
  | "RPC_ERROR"
  | "CONNECT_FAILED"
  | "DAEMON_NOT_FOUND";

export class MuxClientError extends Error {
  readonly code: ClientErrorCode;
  readonly rpcCode?: number;
  constructor(code: ClientErrorCode, message: string, rpcCode?: number) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

export class BlockedError extends MuxClientError {
  readonly reason: string;
  readonly rawReply: string;
  readonly sessionId?: string;
  constructor(sessionId: string | undefined, reason: string, rawReply: string) {
    super(
      "BLOCKED",
      `Session ${sessionId ?? "(unknown)"} blocked: ${reason}`,
    );
    this.reason = reason;
    this.rawReply = rawReply;
    this.sessionId = sessionId;
  }
}

const JSONRPC_CODE_TO_CLIENT_CODE: Record<number, ClientErrorCode> = {
  1001: "SESSION_NOT_FOUND",
  1002: "SESSION_DEAD",
  1003: "TIMEOUT",
  1010: "BLOCKED",
  1020: "PTY_SPAWN_FAILED",
  1021: "CLAUDE_NOT_FOUND",
};

export function buildErrorFromRpc(rpcError: {
  code: number;
  message: string;
  data?: unknown;
}): MuxClientError {
  if (rpcError.code === 1010) {
    const d = (rpcError.data ?? {}) as {
      reason?: string;
      sessionId?: string;
      rawReply?: string;
    };
    return new BlockedError(
      d.sessionId,
      d.reason ?? "(no reason)",
      d.rawReply ?? "",
    );
  }
  const code = JSONRPC_CODE_TO_CLIENT_CODE[rpcError.code] ?? "RPC_ERROR";
  return new MuxClientError(code, rpcError.message, rpcError.code);
}
