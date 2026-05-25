/**
 * 공개 타입 정의 — 데몬과 클라이언트가 공유.
 */

export type SessionMode = "automation" | "chat" | "streaming";

/**
 * 세션 트리거 — 호출 의도를 처음부터 선언.
 *  - on-demand: 외부 메시지 도착마다 send (Bridge 패턴 A — 봇 응답)
 *  - scheduled: cron 표현식대로 자동 실행 (Runner 패턴 B — 옵티마이저)
 *  - loop: 고정 interval 루프 (Runner 패턴 B — watchdog polling)
 */
export type TriggerKind = "on-demand" | "scheduled" | "loop";

/** 요일 (cron 호환: 0=일, 1=월, ..., 6=토) */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * 스케줄 정책 — Runner 세션 생성 시 사용.
 * cron 한 줄로도 다 표현되지만, 자주 쓰는 패턴은 친절한 옵션 제공.
 * 둘 다 지정되면 cron 우선, 나머지 필드는 skip 조건으로 작용.
 */
export interface SchedulePolicy {
  /** Cron 표현식 (예: every 10 min on weekdays 9-15h) — 가장 표현력 높음 */
  cron?: string;

  /** 또는: 간단 옵션 (cron 없을 때) */
  /** 매일 실행할 시각들. "HH:mm" 24h. 예: ["09:00", "15:30"] */
  atTimes?: string[];
  /** 간격 (ms). loop 트리거의 기본 표현 */
  intervalMs?: number;

  /** 공통 skip 조건 (cron/interval 모두에 적용) */
  /** 실행 허용 요일. 미지정 시 매일 */
  onWeekdays?: Weekday[];
  /** 이 시간대에는 건너뜀. "HH:mm-HH:mm" 형식. 예: ["00:00-07:00", "23:00-24:00"] */
  skipTimeRanges?: string[];
  /** 이 날짜에는 건너뜀. ISO date (YYYY-MM-DD). 휴일 등 */
  skipDates?: string[];

  /** 타임존 (예: "Asia/Seoul"). 기본 시스템 TZ */
  timezone?: string;
}

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
