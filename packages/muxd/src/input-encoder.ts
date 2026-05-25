/**
 * PTY 입력 인코더.
 *
 * 문제: claude TUI에 메시지를 보낼 때 그냥 `\r`로 끝내면 줄바꿈 있는
 * 입력이 각 줄마다 자동 submit된다. 또 일부 제어문자는 의도치 않은
 * 동작(취소, 모드 전환) 트리거.
 *
 * 해결:
 *  - 입력 본문 안의 \r/\n은 줄바꿈 키 시퀀스로 인코딩
 *  - 위험 제어문자는 제거/escape
 *  - 마지막에 단일 "submit" 시퀀스 추가
 *
 * claude TUI의 정확한 멀티라인 입력 처리는 버전마다 다를 수 있어,
 * 보수적으로 줄바꿈을 공백 + 명시적 마커로 변환하는 길도 옵션으로 둠.
 */

export interface EncodeOpts {
  /**
   * 멀티라인 처리 전략.
   *  - 'flatten': 줄바꿈을 공백으로 (가장 안전, 기본값)
   *  - 'bracketed-paste': bracketed paste 시퀀스로 감쌈 (TUI가 지원하면 정확한 멀티라인)
   *
   * v0.1.0은 'flatten' 기본 — 안정성 우선.
   * bracketed-paste는 claude TUI 버전별 호환 검증 후 활성화.
   */
  multiline?: "flatten" | "bracketed-paste";
}

/** ESC = 0x1B */
const ESC = "\x1B";
const BP_START = `${ESC}[200~`;
const BP_END = `${ESC}[201~`;

/** 제거할 위험 제어문자 (allowlist 외 다 제거):
 *  - Ctrl+C (0x03) — 진행 중 응답 취소 트리거
 *  - Ctrl+D (0x04) — EOF, 세션 종료
 *  - Ctrl+Z (0x1A) — suspend
 *  - 다른 0x00-0x1F 중 \t(0x09), \r(0x0D), \n(0x0A)만 일단 허용
 */
const DANGEROUS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * 사용자 prompt 텍스트를 PTY 주입용 바이트 시퀀스로 변환.
 * 마지막에 submit (CR) 포함.
 */
export function encodeForPty(text: string, opts: EncodeOpts = {}): string {
  const mode = opts.multiline ?? "flatten";
  // 1. 위험 제어문자 제거
  let body = text.replace(DANGEROUS, "");
  // 2. 멀티라인 처리
  if (mode === "flatten") {
    body = body.replace(/\r\n|\r|\n/g, " ").replace(/\s+/g, " ").trim();
  } else if (mode === "bracketed-paste") {
    // CRLF normalize, bracketed-paste로 감싸기
    body = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    body = `${BP_START}${body}${BP_END}`;
  }
  // 3. submit 추가 (CR)
  return body + "\r";
}

/**
 * 인터럽트 시퀀스 — 응답 진행 중 중단할 때 PTY에 쓴다.
 * claude TUI 버전에 따라 Ctrl+C가 응답 중단 / 전체 종료를 다르게 처리할 수 있음.
 * 우선 Esc로 시도하고 안 되면 Ctrl+C fallback.
 */
export const INTERRUPT_ESC = ESC;
export const INTERRUPT_CTRL_C = "\x03";
