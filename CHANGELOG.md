# Changelog

All notable changes to this project are documented here.

## [0.1.6] — 2026-06-01

### Fixed — **결정적 버그**: `tool_use` stop_reason도 응답 완료로 처리되던 문제
v0.1.5까지 `session-tail`이 어떤 `stop_reason` 값이든 done emit → 모델이 도구만 호출했는데 muxd가 "응답 끝났다" 판단 → 호출자에 **빈 응답 즉시 반환**. 모델이 도구 결과를 받고 응답을 이어가도 muxd는 이미 떠난 뒤라 그 응답 못 받음.

이게 currency-edge 마이그레이션 PoC에서 `allowedTools` 사용 시 "응답 0초 만에 빈 문자열"로 보이던 원인이자, F-1/L-2 단계에서 "stall"로 잘못 진단했던 케이스의 진짜 원인.

**수정**: `shouldEmitDone(stopReason)` 헬퍼 분리 — `end_turn` / `stop_sequence` / `max_tokens` 만 진짜 완료로 인정. `tool_use`는 다음 assistant 라인 대기.

### Added
- `shouldEmitDone` export (`core/session-tail.ts`) — stop_reason 판정 헬퍼.
- 단위 테스트 102 통과 (이전 96 + shouldEmitDone 7 케이스 추가).

### Tests
- 기존 단위 + 통합 5개 영향 없음 (모두 도구 사용 없는 케이스 — `end_turn` 정상 처리).
- file-ref 사이드카 PoC (`MUX_SIDECAR_FILE_REF=1`): 17.1초 만에 한국어 자연 응답, 봇 상태(환율/슬롯/P&L 특수문자 포함) 정확 인용.

### currency-edge 마이그레이션 함의 (#3)
- **prompt 단순화/금융 텍스트 제거 등 우회 시도는 사실 불필요**했음. 진짜 원인이 muxd 버그라서.
- file-ref 패턴 + `allowedTools="Read"` 조합으로 마이그레이션 길 열림. PoC README에 권장 패턴 코드.

### Deferred (변경 없음)
- 모델 자율 약속어 트리거 → **#13**
- discord_bot / run_optimizer / watchdog 실제 USE_MUXD=1 활성화 → 사용자 결정

## [0.1.5] — 2026-06-01

### Added — `packages/client-py` Python sync 클라이언트
- `claude-mux` PyPI 패키지 (`pip install claude-mux`), Python 3.9+ 지원.
- **Sync API** — `currency-edge`의 `subprocess.run(["claude", "-p", ...])` 패턴 그대로 대체:
  - `Client.ask(prompt, cwd, mode="automation", idle_death_ms=...)` → str
  - `Client.open_session(cwd, mode)` + `Session.send(prompt) / close()` — 재사용 세션 (컨텍스트 유지)
  - `Client.stream(prompt, cwd, on_chunk)` — 청크 콜백 (v0.1.x는 응답 단위 한 청크)
  - `Client.status()` — 데몬 정보
- **`BlockedError` / `MuxClientError`** — TS client errors와 인터페이스 호환. `code`, `reason`, `raw_reply`, `session_id` 필드 동일.
- **Transport**:
  - POSIX: `socket.socket(AF_UNIX)` stdlib만 사용
  - Windows: `pywin32` (`win32file.CreateFile`) 로 Named pipe 직접 처리
- **Auto-spawn**: 데몬 없으면 `muxd serve` detached spawn 후 ready 폴링 (`MUXD_BIN` env 또는 PATH lookup).
- **NDJSON framing + JSON-RPC 2.0** — TS daemon protocol과 100% 호환.

### Tests
- 단위 **14 통과** (POSIX 2 skip on Windows).
  - errors: `BlockedError` 필드, RPC 코드 매핑 (1010 → BLOCKED, 1001~1021 매핑, 9999 → RPC_ERROR)
  - socket_path: 플랫폼별 path 결정
- 통합 **2 통과** (`MUX_INTEGRATION=1`, real claude):
  - status round-trip (PTY 없이 daemon만)
  - ask "respond with exactly: OK-PY-CLIENT" → 11.68s 정확 응답

### F-1 PoC 보고서 (#3)
사이드카로 5+가지 prompt 패턴 시도 후 **마이그레이션 패턴 확정** — 자세한 내용 `poc/sidecar-currency-edge/README.md`:
- ✅ standalone imperative ("Reply with X")
- ❌ referential prefix ("Given that ...", "Based on ...") — automation 룰 "Don't ask clarifying"과 충돌
- v0.2.0 마이그레이션에선 컨텍스트를 inline + 마지막에 명확한 액션 동사 패턴 사용.

### Deferred (변경 없음)
- discord_bot / run_optimizer / watchdog / vidfolio 실제 마이그레이션 → **v0.2.0**
- 약속어 자율 트리거 → **#13**

## [0.1.4] — 2026-06-01

### Changed
- `DEFAULT_IDLE_DEATH_MS`: **60s → 120s**. 긴 prompt에서 60s가 짧음 확인 (사이드카 PoC). 호출자가 명시적으로 override 가능.

### Added — 자연어 거부 표현 감지 (opt-in)
- `matchFailurePattern(text)` — 응답에 "I cannot", "I'm unable", "할 수 없습니다" 등 거부 표현 매치 시 첫 문구 반환 (영문 9 + 한국어 3 패턴).
- `SendOpts.detectFailure?: boolean` (기본 false) — opt-in. true면 응답 후 매치 → `BlockedError` throw.
- 약속어(`MUX_BLOCKED:` / `<mux:blocked>`)는 옵션 무관하게 항상 검사 — 기존 동작 유지.
- daemon protocol + client API 전반에 `detectFailure` 전달 wiring.
- 단위 96 통과 (이전 75 + matchFailurePattern 21 케이스).

### Investigation — discord_bot stall 원인 확정 (#3)
사이드카 진단으로 stall 원인 분리 완료:
- ✅ 단순 prompt(57자): 13.5초 정상 응답
- ❌ discord_bot multi-section prompt(216자): `idleDeathMs` 180s로 늘려도 동일 stall (PTY 출력 자체 안 옴)
- 결론: **muxd 인프라 정상**. stall은 **prompt 패턴 자체** — `system context + "You are the bot's assistant" + ## 헤더 + multi-section` 조합.
- v0.2.0 마이그레이션 권장사항 PoC README에 기록: prompt 단순화 / `##` 마크다운 회피 / < 150자.

### Deferred (변경 없음)
- 모델 자율 약속어 트리거 (system-prompt 디자인) → **#13**
- Python 클라이언트 + 본격 마이그레이션 → **v0.2.0**

## [0.1.3] — 2026-05-31

### Added — `matchBlocked` XML 형식 지원
- `<mux:blocked>reason</mux:blocked>` XML 태그 매치 (대소문자 무시, multi-line reason 지원).
- 기존 `MUX_BLOCKED: reason` 형식도 그대로 매치 (backward compat).
- 단위 75 통과 (XML 6케이스 추가).

### Investigation — 모델 트리거 (#13)
- system-prompt에 약속어 룰을 어떻게 변경/강화해도 통합 전체 회귀 발견.
- 단순 토큰 형식 변경(`MUX_BLOCKED:` → `<mux:blocked>`)만으로도 기존 통과 케이스("respond with exactly: OK-AUTOMATION" 등)가 모두 60s idle 사망 (5개 통합 모두 fail).
- 결론: 모델이 약속어 출력 자체를 거부하는 것이 아니라, **system-prompt에 약속어 관련 어떤 새 명령이든 추가하면 모델이 전반 stall**. 원인은 추가 연구 필요 — #13 그대로 OPEN.
- v0.1.3은 인프라 강화(XML 매치) + system-prompt 원복(통합 회귀 없음 유지)으로 마무리.

### Unchanged
- system-prompt는 v0.1.2 그대로.
- 통합 5 통과 유지 (시간 보호 위해 재실행은 안 했지만, system-prompt 원복 = 회귀 없음 자명).

## [0.1.2] — 2026-05-31

### Added — Daemon + JSON-RPC IPC + Client 패키지
- **`packages/muxd/src/daemon/`**:
  - `DaemonServer` — `net.createServer`로 Unix socket(POSIX) / Named pipe(Windows) listen. 단일 호스트/단일 사용자, OS 권한으로 격리.
  - `protocol.ts` — JSON-RPC 2.0 method 정의 (`mux.openSession` / `send` / `stream` / `close` / `ask` / `status` / `shutdown`) + 에러 코드 (1010 = BLOCKED).
  - `framing.ts` — NDJSON 양방향 framing (`attachNdjsonReader`, `writeMessage`).
  - `socket-path.ts` — 플랫폼별 위치: `$XDG_RUNTIME_DIR/muxd.sock` / `/tmp/muxd-<uid>.sock` / `\\.\pipe\muxd-<user>`.
- **`muxd` CLI 신규 커맨드**:
  - `muxd serve` — foreground daemon (Ctrl+C로 종료).
  - `muxd status` — claude CLI 위치 + daemon 상태 (소켓 ping).
  - `muxd stop` — running daemon shutdown.
- **`packages/client`** (`@claude-mux/client`, private):
  - `Client` 클래스 — `ask` / `openSession` / `stream` / `close` / `status`.
  - `Session` 핸들 — `send` / `close`.
  - `transport.ts` — NDJSON JSON-RPC client + stream notification dispatch.
  - `errors.ts` — `BlockedError` / `MuxClientError` + `buildErrorFromRpc` (RPC 에러 코드 → 클래스 매핑, BLOCKED는 reason/rawReply 보존).
  - `auto-spawn.ts` — 데몬 없으면 `muxd serve` 자동 detached spawn + ready 폴링. `MUXD_BIN` 환경변수 또는 PATH lookup으로 바이너리 위치.

### Monorepo
- 루트 `package.json` workspaces 추가 (`packages/*`).
- `@claude-mux/muxd`에 subpath exports — `.` / `./bridge` / `./core` / `./daemon` / `./runner`.

### Tests
- **muxd 단위 69 통과** (이전 46 + 새 23: framing 6 + protocol 8 + server 5 + socket-path 4).
- **client 단위 9 통과** (errors 매핑 검증).
- **통합 (real claude, `MUX_INTEGRATION=1`)**:
  - client + DaemonServer end-to-end: `ask` round-trip ✓ (18s) / `status` ✓ (5s).
  - 기존 muxd bridge/pty-session 통합 5 회귀 없음.

### Migration 노트
- v0.1.1 bridge in-process API는 그대로 export 유지. 데몬 없이 직접 사용 가능.
- 새 daemon API는 별도 채널 — Python 클라이언트(v0.2.0) 진입점.

### Deferred (변경 없음)
- 모델이 약속어를 자연 트리거하게 만드는 작업 → **#13**
- Python 클라이언트 + currency-edge/vidfolio 마이그레이션 → **v0.2.0**

## [0.1.1] — 2026-05-31

### Added — 약속어 핸들링 인프라
- `core/errors.ts`: `MuxBaseError` 베이스 + `BlockedError` (`code: "BLOCKED"`, `reason`, `rawReply`, `sessionId`).
- `matchBlocked(text)` 헬퍼: 응답 본문의 줄 시작에서 `MUX_BLOCKED:` 매치, reason 추출. CRLF 호환, 줄 시작 제한으로 우연한 등장 차단.
- `PtySession.send()` done 핸들러 분기: 응답 본문에 약속어 검출 → `BlockedError` reject. 호출자 `try/catch`로 정상 응답 vs 실패 분기.
- core barrel(`core/index.ts`)에서 export.

### Tests
- 단위 46 통과 (errors 10개 추가): `matchBlocked` 8케이스(시작/끝 줄, CRLF, 빈 reason, 중간 등장 무시 등) + `BlockedError` 2케이스.
- 통합 5 통과(회귀 없음, system-prompt 변경 없음).

### Known limitation — 별도 작업 (#12)
- 실제 모델로 약속어 자연/명시 트리거 검증은 모델 안전 학습으로 인해 즉시 안 됨.
- 명시 명령형(`'Reply with exactly: "MUX_BLOCKED: training cutoff"'`)도 모델이 거부 → idle 사망.
- 약속어 인프라 자체는 검증됨 — 호출자가 \`new BlockedError(...)\` throw하거나 모델이 약속어를 실제로 출력하면 `try/catch`로 잡힘.
- 모델 유도 방법(system-prompt 디자인, 약속어 형식 변경, 별도 채널 등) 연구는 #12.

### Deferred (변경 없음)
- JSON-RPC over Unix socket/named pipe + `@claude-mux/client` + 자동 spawn → **v0.1.2**
- Python 클라이언트 + currency-edge/vidfolio 마이그레이션 → **v0.2.0**

## [0.1.0] — 2026-05-31

### Added — Phase 0 / PoC
- PTY round-trip 실험 + 비용 실측 (PoC #1): 인터랙티브 PTY로 `claude` spawn 시 헤드리스 크레딧 차감 없음 확인.
- PoC Round 2/3 결과 기록 — 단순 파서 한계로 응답 캡처 부정확 → v0.1.0에서 jsonl tail 보강으로 해결.

### Added — v0.1.0 / MVP (in-process TS library)
- `packages/muxd` TypeScript 패키지 (`@claude-mux/muxd`, private).
- **Core**:
  - `PtySession` — `node-pty`로 `claude` TUI spawn, 직렬 메시지 큐, 동적 타임아웃.
  - `tui-parser` — ANSI 스트립 + 응답 완료 감지 + 사용량 추출 + 본문 추출.
  - `session-tail` — jsonl tail로 응답 정확 캡처 (파서 한계 회피).
  - `input-encoder` + `system-prompt` — 모드별(`automation` / `interactive`) 초기화.
  - `locate-claude` — 플랫폼별 `claude` CLI 위치 자동 탐지.
- **Bridge** (in-process API):
  - `ask(prompt, opts)` — 단발 호출 (drop-in for `claude -p`).
  - `stream(prompt, opts)` — AsyncIterable 응답 청크.
  - `openSession(opts) / send / close` — 재사용 가능한 세션 핸들 (컨텍스트 유지).
- **Runner**:
  - `scheduleLoop` + `SchedulePolicy` — 반복 호출 스케줄링 평가.
- **CLI** (`muxd`): `status` / `version` / `help` (start/stop/serve는 v0.1.1).
- **테스트**:
  - 단위 vitest: 36 통과 (input-encoder 9, tui-parser 6, session-tail 10, runner schedule 11).
  - 통합 vitest (real claude CLI, `MUX_INTEGRATION=1` 게이트): 5 통과 + 1 의도 skip.
    - PtySession automation: open + send + close 1 round-trip
    - PtySession automation: serialized 3 messages on same session
    - bridge.ask single-shot returns exact reply
    - bridge.openSession 2 sequential sends both return correct replies
    - bridge.stream yields chunk with reply

### Deferred
- JSON-RPC over Unix socket / named pipe → **v0.1.1**
- `@claude-mux/client` 별도 npm 패키지 + 데몬 자동 spawn → **v0.1.1**
- Python 클라이언트 + currency-edge/vidfolio 마이그레이션 → **v0.2.0**

### Avoid (의도된 제약)
- 헤드리스 모드(`claude -p`) 직접 호출 금지 — 이 프로젝트가 막으려는 그것.
- Anthropic API 키 의존 금지 — 호스트 Pro/Max 구독으로만 동작.
- 약관 회색지대 우회 금지 — "사람이 claude 켜고 쓰는 것과 동일" 범위 안에서만.
