# claude-mux

## 본질
`claude -p` (헤드리스) 호출을 **PTY 인터랙티브 세션 멀티플렉싱**으로 대체하는 범용 라이브러리/데몬.

**왜**: 2026-06-15부터 `claude -p`는 Pro/Max 구독 외 별도 크레딧 차감. 인터랙티브 TUI는 구독 한도 유지. → 사람이 `claude` 켜고 채팅하는 것과 동일하게 PTY로 spawn → stdin/stdout 가로채면 호출당 비용 0.

## 아키텍처

```
┌─ 사용자 앱 N개 (currency-edge / vidfolio / Council / 등) ─┐
│  각 앱이 1+개의 client 인스턴스 보유                       │
│  각 client는 자기만의 session_id로 muxd에 요청             │
└──────────────────────┬─────────────────────────────────┘
                       │ JSON-RPC (sessionId 명시)
            ┌──────────▼──────────────────────────┐
            │  muxd (TS 데몬, 단일 인스턴스)        │
            │  ├─ 세션 레지스트리 {id → PTY}        │  ← 절대 공유 금지
            │  ├─ 라우팅: 요청.sessionId → PTY      │
            │  ├─ 메시지 큐 (세션당 직렬)            │  같은 세션 동시 메시지 보호
            │  └─ ANSI/stream 파서                  │
            └──────────┬──────────────────────────┘
                       │ node-pty (PTY 1개당 claude 1개)
            ┌──────────▼──────────────────────────┐
            │  claude (TUI) #1   sess=abc-uuid     │
            │  claude (TUI) #2   sess=def-uuid     │
            │  claude (TUI) #N   sess=...          │
            │  ↑ 각 세션 독립. 컨텍스트 절대 안 섞임 │
            └─────────────────────────────────────┘
```

### 세션 격리 원칙 (핵심)
- **한 클라이언트 호출 = 한 세션 PTY**. 절대 세션 간 메시지 공유/병합 금지
- 20개 프로젝트가 동시에 호출하면 → muxd가 20개 PTY 띄움 (또는 재사용 풀에서 매칭)
- 클라이언트가 `sessionId` 가지고 있으면 → 무조건 그 PTY로만 라우팅
- `openSession()` 호출 시 새 `sessionId` 발급 + 새 PTY spawn
- `close()` 시 PTY kill + 레지스트리 제거

## 핵심 API (계획)

```ts
// 1. 단발 — claude -p 드롭인 대체
const text = await mux.ask(prompt, { cwd, allowedTools, timeoutMs });

// 2. 스트리밍 — SSE/chunk 콜백
for await (const chunk of mux.stream(prompt, opts)) { ... }

// 3. 세션 재사용 — 옵티마이저 메모리, Council 회의실
const s = await mux.openSession({ cwd, allowedTools });
await s.send('첫 메시지');
await s.send('컨텍스트 이어서');
await s.close();
```

## 마일스톤
1. **Phase 0 / PoC** — PTY로 `claude` 인터랙티브 spawn, 메시지 1왕복 + 비용 실측
2. **v0.1.0 / MVP** — `ask` / `stream` / `openSession` + TS 클라이언트 + 데몬
3. **v0.2.0 / 마이그레이션** — Python 클라이언트 + currency-edge(4곳) / vidfolio(2곳) 적용

## 금지/주의 (Avoid)
- **헤드리스 모드(`claude -p`)를 직접 호출하지 말 것** — 이 프로젝트가 막으려는 그것
- **Anthropic API 키 의존 금지** — 호스트 Pro/Max 구독으로만 동작
- **약관 회색지대 우회 금지** — "사람이 `claude` 켜고 쓰는 것과 동일" 범위 안에서만. 공유 계정/자동 로그인 우회/abuse 패턴 금지
- **ANSI 파싱은 정규식보다 라이브러리 우선** (`strip-ansi`, `ansi-to-text`) — 직접 짜면 깨짐
- **claude CLI TUI 출력 형식은 버전에 따라 바뀜** — 파서 분리 + 버전 감지 + fallback

## 기술 스택
- **데몬**: TypeScript + Node.js, `node-pty` (Win/Mac/Linux)
- **IPC**: JSON-RPC over Unix socket (Linux/Mac) / Named pipe (Windows)
- **클라이언트**: TypeScript (npm `@claude-mux/client`), Python (`pip install claude-mux`)
- **테스트**: vitest (TS), pytest (Python)

## 참조
- 도메인/패턴: `docs/know-how/*.md`
- 상세 스펙: `docs/spec.md`
- 라이브러리 호환 토대(Anthropic SDK 등): code.claude.com/docs/en/headless

## Claude Code 가드레일
- 마일스톤 이슈(`gh issue list`) 먼저 확인하고 작업 컨텍스트 잡을 것
- 한 번에 한 마일스톤만 진행. Phase 0 검증 안 되면 v0.1.0 작업 금지
- 호출당 비용 실측 결과를 `docs/cost-poc.md`에 항상 갱신
