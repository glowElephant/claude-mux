/**
 * 공개 타입 정의 — 데몬과 클라이언트가 공유.
 */

export type SessionMode = "automation" | "chat" | "streaming";

export interface OpenSessionOpts {
  /** 세션 작업 디렉토리 (claude CLI cwd) */
  cwd: string;
  /** 호출자 식별 (system prompt에 주입됨) */
  invoker?: string;
  /** 세션 모드 — system prompt 자동 주입 동작 결정 */
  mode?: SessionMode;
  /** 허용 도구 목록 (예: "Bash WebSearch Read Edit"). claude TUI 인자가 아니라 첫 메시지 system context로 전달. */
  allowedTools?: string;
  /** Claude resume할 기존 세션 ID (있으면 --resume 사용) */
  resumeId?: string;
  /** PTY size */
  cols?: number;
  rows?: number;
}

export interface AskOpts extends OpenSessionOpts {
  /** 단발 호출 타임아웃 (ms) */
  timeoutMs?: number;
}

export interface SessionInfo {
  id: string;
  pid: number;
  mode: SessionMode;
  invoker: string;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
  queueDepth: number;
  busy: boolean;
}

/** 데몬이 throw하거나 응답에 담는 표준 에러 코드 */
export type MuxErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_DEAD"
  | "TIMEOUT"
  | "QUEUE_FULL"
  | "BLOCKED" // Claude가 MUX_BLOCKED 응답한 경우
  | "PTY_SPAWN_FAILED"
  | "CLAUDE_NOT_FOUND"
  | "AUTH_REQUIRED";

export interface MuxError extends Error {
  code: MuxErrorCode;
  sessionId?: string;
}

/** 표준 약속어 — Claude 응답에서 감지 */
export const MUX_TOKENS = {
  BLOCKED: "MUX_BLOCKED:",
  NEEDS_INPUT: "MUX_NEEDS_INPUT",
} as const;
