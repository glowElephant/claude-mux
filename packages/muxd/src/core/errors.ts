/**
 * muxd 에러 클래스 — 모델 약속어(MUX_BLOCKED 등) 또는 인프라 실패를
 * 호출자에게 결정적으로 알리기 위한 throw 대상.
 *
 * 약속어 흐름:
 *  1. system prompt가 모델에게 "할 수 없으면 MUX_BLOCKED: <reason> 한 줄로 답해" 시킴
 *  2. 모델 응답이 jsonl에 기록되면 session-tail이 done 이벤트로 본문 전달
 *  3. PtySession이 본문에서 약속어 검출 → reply 대신 BlockedError throw
 *  4. 호출자는 try/catch로 정상 응답 vs 실패 분기
 *
 * 모델이 약속어를 안 쓰면 stall → idleDeath fallback (별개 흐름).
 */

import type { MuxErrorCode } from "./types.js";
import { MUX_TOKENS } from "./types.js";

/** 모든 muxd 에러의 공통 베이스 — `code`로 분기 가능 */
export class MuxBaseError extends Error {
  readonly code: MuxErrorCode;
  readonly sessionId?: string;

  constructor(code: MuxErrorCode, message: string, sessionId?: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.sessionId = sessionId;
  }
}

/**
 * 모델이 `MUX_BLOCKED: <reason>` 약속어로 응답 — task가 불가능함을 명시.
 * 호출자는 `.reason`으로 사유 확인 후 fallback(재시도 / 다른 도구 / 사용자에게 보고) 결정.
 */
export class BlockedError extends MuxBaseError {
  readonly reason: string;
  /** 모델이 출력한 원본 응답 본문 — 디버깅/로그용 */
  readonly rawReply: string;

  constructor(sessionId: string, reason: string, rawReply: string) {
    super("BLOCKED", `Session ${sessionId} blocked: ${reason}`, sessionId);
    this.reason = reason;
    this.rawReply = rawReply;
  }
}

/**
 * 응답 본문에서 약속어를 찾아 reason 추출.
 *
 * 두 형식 모두 매치 (v0.1.3+ — 모델이 MUX_ prefix를 system token으로 인식해서
 * 안전상 출력 거부하는 경향 우회):
 *   1. XML 형식 (선호): `<mux:blocked>reason</mux:blocked>` — 일반 마크업으로 인식
 *   2. 기존 형식 (backward compat): 줄 시작에 `MUX_BLOCKED: reason`
 *
 * 매치 규칙:
 *  - XML: 본문 어디든 매치 (multi-line 대응)
 *  - 기존: 줄 시작에 토큰 (정상 응답 우연한 등장 차단)
 *
 * 반환: 매치되면 reason 문자열, 없으면 null.
 */
const XML_BLOCKED_RE = /<mux:blocked>([\s\S]*?)<\/mux:blocked>/i;

/**
 * 자연어 거부 표현 패턴. 모델이 약속어 안 쓸 때 fallback 신호로 사용.
 *
 * **false positive 위험**: 정상 응답에 "I'm sorry" 같은 표현이 우연히 들어갈 수
 * 있으므로 opt-in. 핵심은 **거부 의도가 명확한** 문구만.
 *
 * 영문 + 한국어 케이스를 모두 커버. 더 추가 필요하면 여기에 한 줄씩.
 */
const FAILURE_PATTERNS: RegExp[] = [
  // 영문 — 명확한 거부 표현
  /\bI (?:cannot|can't|am unable to|am not able to|do not have access|don't have access)\b/i,
  /\bI'm (?:unable to|not able to|sorry,? (?:but )?I (?:cannot|can't))/i,
  /\bSorry,? (?:but )?I (?:cannot|can't)\b/i,
  /\bUnfortunately,? I (?:cannot|can't)\b/i,
  /\b(?:this is|that's|that is) (?:impossible|not possible)\b/i,
  // 한국어 — "죄송하지만 ... 수 없" 같은 거부 구문, 단독 "할 수 없습니다" 류
  /(?:죄송하지만|미안하지만).*수 없/,
  /(?:할 수 없습니다|불가능합니다|접근할 수 없습니다|모르겠습니다)/,
];

/**
 * 응답 본문에서 거부 표현 패턴을 찾아 매치된 첫 문구 반환.
 * 매치 안 되면 null.
 *
 * 자연어라 noise — opt-in 옵션으로만 사용 권장.
 */
export function matchFailurePattern(text: string): string | null {
  for (const re of FAILURE_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

export function matchBlocked(text: string): string | null {
  // 1) XML 우선
  const m = text.match(XML_BLOCKED_RE);
  if (m) {
    const reason = m[1].trim();
    return reason.length === 0 ? "(no reason given)" : reason;
  }
  // 2) 기존 형식 — 줄 시작
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith(MUX_TOKENS.BLOCKED)) continue;
    const reason = t.slice(MUX_TOKENS.BLOCKED.length).trim();
    if (reason.length === 0) return "(no reason given)";
    return reason;
  }
  return null;
}
