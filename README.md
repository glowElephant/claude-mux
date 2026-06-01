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

✅ **v0.1.7** — TS daemon + TS/Python clients + `tool_use` 버그 수정 + debug 모드 (PTY 출력 라이브 관찰). End-to-end 검증 완료 (daemon listen → client connect → ask → real claude round-trip + file-ref 패턴 통과). currency-edge / vidfolio에 USE_MUXD 토글 인프라 머지됨. 실제 활성화는 사용자 결정 시점.

## Roadmap

- [x] **Phase 0 / PoC** — PTY round-trip + billing verification (PoC #1 passed: no headless credit consumed for PTY-interactive)
- [x] **v0.1.0 / MVP** — `ask` / `stream` / `openSession` as in-process TS library
- [x] **v0.1.1 / promised-tokens** — `BlockedError` + `matchBlocked` + `PtySession.send` throw 분기
- [x] **v0.1.2 / daemon** — JSON-RPC over Unix socket / named pipe + `@claude-mux/client` + auto-spawn
- [x] **v0.1.3 / XML matchBlocked** — `<mux:blocked>reason</mux:blocked>` 형식 지원 (backward-compatible)
- [x] **v0.1.4 / failure detection** — `idleDeathMs` 기본 60s→120s + `detectFailure` opt-in (자연어 거부 표현 매치)
- [x] **v0.1.5 / Python client** — `pip install claude-mux` (sync API, POSIX Unix socket + Windows Named pipe via pywin32)
- [x] **v0.1.6 / tool_use fix** — `stop_reason="tool_use"`도 done 처리되던 결정적 버그 수정. file-ref 패턴 + `allowedTools="Read"`로 마이그레이션 길 열림 ([PoC](poc/sidecar-currency-edge/README.md))
- [x] **v0.1.7 / debug mode** — `MUXD_DEBUG=1` + `muxd debug list/view` — PTY 출력 라이브 관찰 (의존성 0)
- [ ] **v0.2.0 / migration** — currency-edge / vidfolio에 `USE_MUXD=1` 실제 활성화 (인프라는 머지 완료)

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

### v0.1.7 — Debug mode (관찰)

PTY 세션이 백그라운드라 보이지 않음 — 디버깅용 라이브 관찰:

```bash
# 1. 디버그 모드로 데몬 띄움
$ MUXD_DEBUG=1 muxd serve

# 2. 다른 터미널 — 활성/종료 세션 목록
$ muxd debug list
[alive] f4e21a8b  currency-edge-discord-bot   automation  12s  ring=87
         cwd: C:\Git\currency-edge

# 3. 또 다른 터미널 — 그 세션 PTY 출력 stream (prefix 8자로 매칭)
$ muxd debug view f4e21a8b
... (ring 누적 출력) ...
--- live ---
... (실시간 PTY stream — ANSI 컬러 그대로) ...
```

여러 세션 동시 보기: cmd 창 여러 개 띄우고 각각 `muxd debug view <다른 prefix>`. Windows taskbar로 스위칭.

> `MUXD_DEBUG` 미설정이 기본. 메모리 ring buffer만 사용 (500줄/세션), 디스크 0, 의존성 0.

### v0.1.5 — Python client

`subprocess.run(["claude", "-p", ...])` 패턴 그대로 대체:

```python
from claude_mux import Client, BlockedError, MuxClientError

c = Client()  # 자동 connect — 데몬 없으면 spawn

try:
    text = c.ask(
        "Read /tmp/ctx.txt and answer briefly.",  # file-ref 패턴 권장
        cwd="/path/to/project",
        mode="automation",
        allowed_tools="Read",
        idle_death_ms=120_000,
    )
except BlockedError as e:
    print(f"blocked: {e.reason}")
except MuxClientError as e:
    print(f"mux error ({e.code}): {e}")
finally:
    c.close()
```

자세한 사용법: [`packages/client-py/README.md`](packages/client-py/README.md).

### file-ref 패턴 (v0.1.6+ 권장)

긴 prompt(컨텍스트 + 명령)를 PTY에 그대로 보내면 모델이 응답 생성 못 시작하는 경우가 있음 (특히 자동화 모드).
**우회**: 컨텍스트를 임시 파일에 저장, prompt는 짧은 `Read X and follow instructions` + `allowedTools="Read"`.

```python
import tempfile, uuid
from pathlib import Path

# 1. 컨텍스트를 임시 파일에 저장
ctx_path = Path(tempfile.gettempdir()) / f"ctx-{uuid.uuid4().hex[:8]}.txt"
ctx_path.write_text(big_prompt_with_context, encoding="utf-8")

# 2. 짧은 prompt만 보냄
text = client.ask(
    f"Read {ctx_path.as_posix()} and follow the instructions inside. Reply with the result.",
    cwd=...,
    mode="automation",
    allowed_tools="Read",  # 필수
)

# 3. cleanup
ctx_path.unlink(missing_ok=True)
```

자세한 검증 매트릭스: [`poc/sidecar-currency-edge/README.md`](poc/sidecar-currency-edge/README.md).

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

> Python은 v0.1.5+ `pip install claude-mux` (위 섹션 참조).

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
