# claude-mux

> **PTY-based Claude Code session multiplexer.** Replace `claude -p` headless calls with interactive sessions to stay inside your Pro/Max subscription after the 2026-06-15 billing change.

## Why

From 2026-06-15, `claude -p` (headless / print mode) is metered against a separate credit pool on Pro ($20/mo) / Max ($100–200/mo) plans. Interactive TUI (`claude` no args) stays inside the regular subscription.

`claude-mux` spawns `claude` as an interactive TUI inside a PTY (pseudo-terminal), then your apps talk to it programmatically via a daemon. From Anthropic's perspective it looks identical to a human typing — no headless credits consumed.

## Goal

```python
# before
proc = subprocess.run(["claude", "-p", ...], input=prompt, ...)

# after
from claude_mux import Client
text = Client().ask(prompt)
```

Drop-in replacement, zero headless billing impact.

## Status

✅ **v0.1.0** — TS in-process library (`@claude-mux/muxd`) with `ask` / `stream` / `openSession`. Real-claude round-trip verified (5 integration tests + 36 unit). Daemon/IPC and Python client deferred to v0.1.1 / v0.2.0.

## Roadmap

- [x] **Phase 0 / PoC** — PTY round-trip + billing verification (PoC #1 passed: no headless credit consumed for PTY-interactive)
- [x] **v0.1.0 / MVP** — `ask` / `stream` / `openSession` as in-process TS library
- [ ] **v0.1.1 / daemon** — JSON-RPC over Unix socket / named pipe + `@claude-mux/client` package + auto-spawn
- [ ] **v0.2.0 / migration** — Python client + migrate `currency-edge` / `vidfolio`

## Usage (v0.1.0 — TS in-process)

```ts
import { ask, openSession, stream } from "@claude-mux/muxd/bridge";

// 1. one-shot (drop-in for `claude -p`)
const text = await ask("이 함수 리팩토링 제안해줘", {
  cwd: "/path/to/project",
  mode: "automation",          // 또는 "interactive"
  timeoutMs: 60_000,
});

// 2. reusable session — context preserved across sends
const s = await openSession({ cwd: "/path/to/project", mode: "automation" });
await s.send("프로젝트 구조 요약해줘");
await s.send("그 중 risky한 부분만 다시 알려줘");   // ← 이전 컨텍스트 유지
await s.close();

// 3. streaming
for await (const chunk of stream("긴 응답이 필요한 프롬프트", opts)) {
  process.stdout.write(chunk);
}
```

> v0.1.0은 in-process. Python에서 쓰려면 v0.2.0 (Python client) 대기 또는 v0.1.1 daemon + JSON-RPC.

## Architecture

```
N apps → N clients (TS/Python) → muxd daemon → N isolated PTY sessions
```

Each session is fully isolated — 20 concurrent apps get 20 independent `claude` PTYs, contexts never bleed.

## Development

```bash
cd packages/muxd
npm install
npm test                                                          # 단위 36개
MUX_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts  # 통합 5개 (실제 claude 호출)
```

통합 테스트는 `claude` CLI가 PATH에 있고 Pro/Max 로그인 상태여야 함. PTY round-trip + 직렬 큐 + bridge API 3종 (`ask`/`openSession`/`stream`) 검증.

## License

TBD (likely MIT)

---

Built to solve a billing edge case. Hopefully irrelevant if Anthropic ever expands subscription to cover headless properly.
