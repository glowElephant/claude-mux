/**
 * claude TUI 출력 파서.
 *
 * 책임:
 *  - 응답 완료 감지 (프롬프트 마커 재출현, 사용량 카운터 갱신, idle)
 *  - 응답 텍스트 추출 (사용자 echo / 스피너 / 푸터 제거)
 *  - 인증 상태 검증
 *  - 사용량 카운터 캡처
 *
 * 주의: claude CLI TUI 출력은 안정 API가 아니다.
 * 정규식은 보수적으로, 실패 시 fallback (idle 타이머 등).
 */

import stripAnsiMod from "strip-ansi";
const stripAnsi = (stripAnsiMod as any).default ?? stripAnsiMod;

/** 사용자 입력 프롬프트 마커 (TUI 입력란 좌측). 응답 완료 후 다시 나타남. */
const PROMPT_MARKER = /^❯\s/m;

/** 사용량 카운터 라인. 예: "5시간:20%(0h7m) 7일:38%(2d11h)" */
const USAGE_LINE = /(\d+)\s*시간\s*:\s*(\d+)\s*%[\s\S]{1,40}?7\s*일\s*:\s*(\d+)\s*%/;

/** Claude TUI 부팅/인증 라인. "Opus 4.7 ... Claude Max" 같은 형태 (| 유무 무관) */
const AUTH_LINE = /(Opus|Sonnet|Haiku)[\s\S]{1,80}?Claude\s+(Max|Pro|Team|Enterprise)/i;

/** 자주 보이는 스피너 단어들 (출력 노이즈) — `…`(ellipsis)도 노이즈로 취급 */
const SPINNER_WORDS =
  /Thundering|Thinking|Pondering|Brewing|Cooking|Baked|tokens?|↑|↓|↻|✢|✶|✻|✽|●|◐|◓|◑|◒/g;

export interface UsageSnapshot {
  fiveHourPct: number;
  sevenDayPct: number;
}

export interface ParsedFrame {
  text: string;
  usage: UsageSnapshot | null;
  authed: boolean;
  promptReady: boolean;
}

/**
 * 누적된 raw PTY 출력에서 핵심 신호를 추출.
 * 호출자는 한 응답이 끝날 때마다 (또는 주기적으로) 이걸 부른다.
 */
export function parseFrame(raw: string): ParsedFrame {
  const clean = stripAnsi(raw);
  return {
    text: clean,
    usage: extractUsage(clean),
    authed: AUTH_LINE.test(clean),
    promptReady: PROMPT_MARKER.test(clean),
  };
}

export function extractUsage(cleanText: string): UsageSnapshot | null {
  const m = cleanText.match(USAGE_LINE);
  if (!m) return null;
  return {
    fiveHourPct: Number(m[2]),
    sevenDayPct: Number(m[3]),
  };
}

/**
 * 마지막 응답 본문만 추출 (사용자 입력 echo + 부팅 노이즈 + 스피너 제거).
 *
 * 입력: 한 메시지 보낸 직후~응답 끝까지의 raw 청크
 * 출력: 모델이 실제로 말한 본문 텍스트
 *
 * 전략 (보수적):
 *  1. ANSI strip
 *  2. 스피너 단어 라인 제거
 *  3. 입력 echo 라인(`❯ ...` 시작) 제거
 *  4. 푸터 라인(사용량 카운터, 모델명 라인) 제거
 *  5. 공백 라인 정리
 *  6. 남은 텍스트 trim
 *
 * 알려진 한계 (TODO 후속 커밋):
 *  - 응답 중에 ❯ 토큰이 본문에 포함되면 echo로 오인 가능
 *  - 코드블록 안 줄바꿈/들여쓰기 보존은 strip만으로 부족할 수 있음
 *  - claude CLI 버전이 바뀌면 푸터 패턴 깨질 수 있음
 */
export function extractAssistantText(raw: string): string {
  const clean = stripAnsi(raw);
  const lines = clean.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("❯")) continue; // 입력 프롬프트 echo
    if (USAGE_LINE.test(trimmed)) continue; // 푸터 사용량
    if (AUTH_LINE.test(trimmed)) continue; // 부팅 모델 라인
    // 박스 그림 / 헤더 (─, ╭, ╮, ╰, ╯, │ 와 공백·텍스트 조합 — 길이 짧으면 잘라냄)
    if (/^[─╭╮╰╯│\s]+$/.test(trimmed)) continue;
    if (/^[╭╮╰╯│].*ClaudeCode/i.test(trimmed)) continue;
    if (/Welcome|Tips for|What's new|release-notes|\/init/.test(trimmed) && out.length === 0)
      continue; // 부팅 안내 (초반에만)
    // 스피너 단어 + … (ellipsis 단독) + 시간/토큰 조각 제거
    let stripped = trimmed
      .replace(SPINNER_WORDS, "")
      .replace(/\(\s*\d+\s*[smh][\s\S]*?\)/g, "") // (3s · ↓1 tokens) 형태
      .replace(/[…⋯]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!stripped) continue;
    out.push(stripped);
  }
  return out.join("\n").trim();
}
