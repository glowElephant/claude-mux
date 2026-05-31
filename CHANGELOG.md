# Changelog

All notable changes to this project are documented here.

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
