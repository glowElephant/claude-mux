/**
 * JSON-RPC 2.0 message types over NDJSON framing.
 *
 * Framing: 한 줄에 한 메시지(JSON), 줄바꿈(\n)으로 종료.
 * 양방향 — 서버가 stream용으로 클라이언트에 notification 보낼 수도 있음.
 *
 * Errors: BLOCKED는 약속어 응답이라 별도 코드. 나머지는 MuxErrorCode 그대로.
 */

import type { MuxErrorCode, OpenSessionOpts, SessionMode } from "../core/types.js";
import type { SendOpts } from "../core/pty-session.js";

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params: P;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: P;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification;

// === Method params ===

/** mux.openSession — 새 PTY 세션 생성, sessionId 반환 */
export interface OpenSessionParams extends OpenSessionOpts {}
export interface OpenSessionResult {
  sessionId: string;
}

/** mux.send — 기존 세션에 메시지, 응답 텍스트 반환 (또는 BLOCKED error) */
export interface SendParams extends SendOpts {
  sessionId: string;
  prompt: string;
}
export interface SendResult {
  text: string;
}

/** mux.stream — send와 동일하지만 청크를 mux.streamChunk notification으로 받음 */
export interface StreamParams extends SendOpts {
  sessionId: string;
  prompt: string;
  /** notification 매칭용 stream id */
  streamId: string;
}
export interface StreamResult {
  /** 최종 누적 텍스트 */
  text: string;
}

/** notification: 서버 → 클라이언트 */
export interface StreamChunkNotification {
  streamId: string;
  chunk: string;
}

/** mux.close — PTY kill + 레지스트리 제거 */
export interface CloseParams {
  sessionId: string;
}
export interface CloseResult {
  ok: true;
}

/** mux.ask — openSession + send + close 한 번에 (in-process bridge.ask와 동일) */
export interface AskParams extends OpenSessionOpts, SendOpts {
  prompt: string;
  mode?: SessionMode;
}
export interface AskResult {
  text: string;
}

/** mux.status — 데몬 상태 */
export interface StatusResult {
  pid: number;
  uptimeMs: number;
  sessions: number;
  version: string;
}

/** mux.shutdown — 데몬 종료 (모든 세션 close 후 exit) */
export interface ShutdownResult {
  ok: true;
}

// === Error codes (JSON-RPC standard codes를 음수로, muxd 도메인은 +1000 영역) ===

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // muxd 도메인
  SessionNotFound: 1001,
  SessionDead: 1002,
  Timeout: 1003,
  Blocked: 1010,
  PtySpawnFailed: 1020,
  ClaudeNotFound: 1021,
} as const;

export function muxCodeToJsonRpc(code: MuxErrorCode): number {
  switch (code) {
    case "SESSION_NOT_FOUND":
      return JsonRpcErrorCode.SessionNotFound;
    case "SESSION_DEAD":
      return JsonRpcErrorCode.SessionDead;
    case "TIMEOUT":
      return JsonRpcErrorCode.Timeout;
    case "BLOCKED":
      return JsonRpcErrorCode.Blocked;
    case "PTY_SPAWN_FAILED":
      return JsonRpcErrorCode.PtySpawnFailed;
    case "CLAUDE_NOT_FOUND":
      return JsonRpcErrorCode.ClaudeNotFound;
    case "AUTH_REQUIRED":
      return JsonRpcErrorCode.InternalError;
    case "QUEUE_FULL":
      return JsonRpcErrorCode.InternalError;
  }
}
