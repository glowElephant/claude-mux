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

✅ **v0.1.2** — Daemon + JSON-RPC IPC + `@claude-mux/client` TS package. End-to-end verified (daemon listen → client connect → ask → real claude round-trip). Auto-spawn daemon if absent. Python client deferred to v0.2.0.

## Roadmap

- [x] **Phase 0 / PoC** — PTY round-trip + billing verification (PoC #1 passed: no headless credit consumed for PTY-interactive)
- [x] **v0.1.0 / MVP** — `ask` / `stream` / `openSession` as in-process TS library
- [x] **v0.1.1 / promised-tokens** — `BlockedError` + `matchBlocked` + `PtySession.send` throw 분기
- [x] **v0.1.2 / daemon** — JSON-RPC over Unix socket / named pipe + `@claude-mux/client` + auto-spawn
- [ ] **v0.2.0 / migration** — Python client + migrate `currency-edge` / `vidfolio`

## Usage

### v0.1.2 — Daemon + Client (production path)

```bash
# 1. 데몬 띄우기 (또는 client가 첫 호출 시 자동 spawn)
npx muxd serve
```

```ts
import { Client } from "@claude-mux/client";

const c = new Client();   // 자동 connect — 데몬 없으면 spawn

// drop-in for `claude -p`
const text = await c.ask("이 함수 리팩토링 제안해줘", {
  cwd: "/path/to/project",
  mode: "automation",
});

// reusable session — context preserved
const s = await c.openSession({ cwd: "/path/to/project", mode: "automation" });
await s.send("프로젝트 구조 요약해줘");
await s.send("그 중 risky한 부분만 다시 알려줘");
await s.close();

// streaming (v0.1.2은 응답 단위 한 청크. 토큰 스트리밍은 후속)
await c.stream("긴 응답이 필요한 프롬프트", { cwd, mode: "automation" }, (chunk) => {
  process.stdout.write(chunk);
});
```

Errors:

```ts
import { BlockedError } from "@claude-mux/client";

try {
  await c.ask(prompt, opts);
} catch (e) {
  if (e instanceof BlockedError) {
    console.warn(`blocked: ${e.reason}`);
    // fallback (재시도 / 다른 도구 / 사용자 보고)
  } else throw e;
}
```

### v0.1.0 — In-process TS (no daemon)

데몬 없이 단일 프로세스에서 직접 PTY 멀티플렉싱:

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

> Python에서 쓰려면 v0.2.0 (Python client) 대기. 그 전엔 raw JSON-RPC over Unix socket / named pipe로 v0.1.2 데몬 직접 호출 가능.

## Architecture

```
N apps → N clients (TS/Python) → muxd daemon → N isolated PTY sessions
```

Each session is fully isolated — 20 concurrent apps get 20 independent `claude` PTYs, contexts never bleed.

## Development

```bash
# 루트 — workspace 설치 + 둘 다 빌드
npm install
npm run build

# 단위 (muxd 69 + client 9)
npm test --workspaces

# 통합 (실제 claude — MUX_INTEGRATION=1)
MUX_INTEGRATION=1 npm run test:integration --workspaces --if-present
```

통합 테스트는 `claude` CLI가 PATH에 있고 Pro/Max 로그인 상태여야 함. PTY round-trip + 직렬 큐 + bridge API + daemon end-to-end 검증.

## License

TBD (likely MIT)

---

Built to solve a billing edge case. Hopefully irrelevant if Anthropic ever expands subscription to cover headless properly.
