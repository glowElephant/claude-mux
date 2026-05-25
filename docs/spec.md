# claude-mux Spec

## Goal
`claude -p` (headless) 호출을 PTY 인터랙티브 세션으로 우회하여, 2026-06-15 정책 변경 후에도 호스트의 Pro/Max 구독 한도 내에서 N개 앱이 N개의 독립 Claude 세션을 동시에 사용할 수 있게 한다.

## Milestones

### Phase 0 — PoC (1주)
**검증 질문**: PTY로 `claude` 인터랙티브 모드를 spawn하고 메시지 N번 주고받을 때 실제로 구독 한도 내에서 처리되는가? 헤드리스 크레딧 차감이 발생하는가?

산출물:
- `poc/pty-roundtrip.mjs` — 가장 단순한 PTY 1회 메시지 + 응답 캡처
- `poc/pty-many.mjs` — 같은 세션에 10/50/100회 메시지 보내기
- `docs/cost-poc.md` — 측정 결과 (Anthropic 콘솔 크레딧 변화)

성공 기준: 100회 메시지에도 헤드리스 크레딧 변화 없음. ANSI/TUI 출력에서 assistant 텍스트 안정적 추출 가능.

실패 시 분기:
- 헤드리스 차감 발생 → 프로젝트 보류, 정책 재검토
- ANSI 파싱 불가 → Agent SDK 검토, MCP server 방식 검토

### v0.1.0 — MVP (3주)
- `muxd` TS 데몬: PTY 풀, 세션 레지스트리, JSON-RPC IPC
- `@claude-mux/client` TS 클라이언트: `ask` / `stream` / `openSession`
- 단위 테스트: ANSI 파싱, 세션 격리, 동시성

### v0.2.0 — Migration (2주)
- `claude-mux` Python 클라이언트 (TS와 동일 API)
- `currency-edge` 4곳 마이그레이션 + 호환성 검증
- `vidfolio` 2곳 마이그레이션 + SSE 스트리밍 호환

## Constraints

- **OS**: Windows / macOS / Linux 전부 동작 (호스트 = 개인 PC)
- **인증**: 호스트가 이미 `claude` CLI로 로그인된 상태만 가정. API 키 경로 없음
- **약관 준수**: 사람이 `claude` 켜고 대화하는 것과 기능적으로 동일한 범위 안에서만. 공유 계정 / 자동 로그인 우회 / abuse 금지
- **버전 호환**: `claude` CLI TUI 출력은 안정 API 아님 → 파서를 분리하고 버전 감지 + fallback 필요

## Domain knowledge

### 호출 패턴 (실측, 2026-05-25 기준)

| 앱 | 위치 | 옵션 |
|---|---|---|
| currency-edge | `discord_bot.py:172` | `-p --dangerously-skip-permissions --verbose --output-format stream-json`, stdin prompt, 120s |
| currency-edge | `run_optimizer.py:191` | `-p --allowedTools "Bash WebSearch WebFetch Read Edit Grep Glob" --dangerously-skip-permissions`, stdin, 600s |
| currency-edge | `run_optimizer.py:342` | 동일 (일일 리뷰) |
| currency-edge | `watchdog.py:114` + `run_optimizer.py:108` | `-p --dangerously-skip-permissions`, stdin error log |
| vidfolio | `server.js:553` | `-p --verbose --output-format stream-json --allowedTools ''`, 90s |
| vidfolio | `server.js:1343` | 동일 + SSE 스트리밍 출력 |

공통:
- 모두 stdin으로 프롬프트 주입
- 6곳 중 5곳이 `stream-json` 출력 + assistant 블록 텍스트 추출 코드 중복
- `--allowedTools` 명시적 제한
- `--dangerously-skip-permissions` 거의 항상

### 세션 격리
한 클라이언트 호출 = 한 PTY. 20개 앱 동시 호출 = 20개 독립 PTY. 컨텍스트 절대 안 섞임.

### IPC
- Linux/Mac: Unix domain socket (`/tmp/claude-mux.sock`)
- Windows: Named pipe (`\\.\pipe\claude-mux`)
- 프로토콜: JSON-RPC 2.0 (요청-응답 + 알림)

## 세션 동작 모델 (핵심)

### 모드
세션 생성 시 `mode` 지정. 데몬이 첫 메시지로 system prompt 자동 주입.

| 모드 | 동작 | 사용처 |
|---|---|---|
| `automation` | 반문 금지, 단답, 진행 narration 없음, 막히면 `MUX_BLOCKED: <reason>` | 자동화 호출 (옵티마이저, watchdog) |
| `chat` | 자유로운 대화, 반문 허용 | Council 회의실 (사람들이 답함) |
| `streaming` | 청크 출력, 반문 허용 | 채팅 UI (SSE 등) |

자동 주입되는 system context 예시 (`automation`):
```
You are being called programmatically by '<invoker>', not by a human.
- Do NOT ask clarifying questions — make best assumption and proceed
- Do NOT narrate progress — final answer only
- If genuinely impossible, respond with literal "MUX_BLOCKED: <reason>"
- Output is parsed by a machine. No emoji, no markdown unless asked.
- Allowed tools: <comma-separated or "none">
```

### 메시지 큐 (세션당 직렬)
- 같은 세션에 N개 메시지 동시 도착 → 큐 → 응답 끝나면 다음
- 응답 끝 감지: TUI 프롬프트 마커(`❯`) 재출현 (idle 타이머는 fallback)
- 큐 길이 상한 (예: 100) → 초과 시 백프레셔(reject)
- 타임아웃 시 `Ctrl+C` 주입 → 큐의 다음 메시지로
- 우선순위 옵션 (host > guest 등)

### 응답 완료 신호 우선순위
1. TUI 프롬프트 마커 재출현 (가장 신뢰)
2. 사용량 카운터 라인 갱신 ("5시간:X% / 7일:Y%")
3. idle N초 (fallback)

### 표준 약속어
| 토큰 | 의미 | 처리 |
|---|---|---|
| `MUX_BLOCKED: <reason>` | Claude가 진행 불가 판단 | 클라이언트 호출에 throw |
| `MUX_NEEDS_INPUT` | (chat 모드 전용) 반문 필요 | 다음 send() 대기 |

## Drop-in 호환 설계 (핵심 가치)

기존 앱(currency-edge, vidfolio)도, 미래 앱(Council 등)도 **최소 변경**으로 붙일 수 있어야 한다.

### 마이그레이션 난이도 목표

| 항목 | 목표 |
|---|---|
| 코드 변경 | **1 함수 호출만 교체** (`subprocess.run(["claude", "-p", ...])` → `mux.ask(...)`) |
| 인자 매핑 | `--allowedTools`, `--dangerously-skip-permissions`, `cwd`, `timeout` 모두 동일 이름의 옵션으로 |
| 출력 형식 | 텍스트 그대로 반환 (stream-json 파싱은 muxd가 흡수) |
| 스트리밍 | `claude -p --output-format stream-json` 패턴 → `mux.stream()` async iterable로 자동 변환 |
| 설치 | `pip install claude-mux` 또는 `npm i @claude-mux/client` 한 줄. 데몬은 첫 호출 시 자동 spawn |

### Compat shim (선택)

기존 코드의 `subprocess.run([...])`를 한 줄 import만으로 가로채는 monkeypatch 모드:

```python
import claude_mux.compat  # 이 import만 추가
# 이하 기존 코드 무수정 — subprocess.run(["claude", "-p", ...])가 muxd로 라우팅됨
```

위험성 있어서 **선택적**으로만 제공. 권장은 명시적 `mux.ask()` 교체.

### 신규 앱 (Council 등) 시작 템플릿

`packages/templates/`에 빠른 시작 예제 제공:
- Node.js Express + SSE 챗봇 (vidfolio 패턴)
- Python Discord 봇 (currency-edge 패턴)
- Python 백그라운드 스케줄러 (옵티마이저 패턴)

각 템플릿은 muxd 의존만 가지고 동작 — 신규 앱이 `claude -p` 직접 부르는 코드를 처음부터 안 쓰도록 유도.

### 데몬 자동 관리

사용자가 데몬을 수동 실행할 필요 없게:
- 클라이언트가 첫 호출 시 IPC 소켓 핑 → 없으면 `muxd` detached spawn
- 데몬은 일정 시간 (예: 30분) 유휴 시 자동 종료, 다음 호출 시 재기동
- `claude-mux daemon status / start / stop` CLI 제공 (디버깅용)

## Avoid

- **헤드리스(`claude -p`) 직접 호출** — 이 프로젝트의 존재 이유와 정반대
- **세션 컨텍스트 공유** — 데이터 유출, 의도치 않은 cross-talk
- **ANSI 정규식 자체 작성** — 의외로 깨짐. `strip-ansi` 같은 검증된 라이브러리 사용
- **`--dangerously-skip-permissions` 기본 ON으로 두기** — 안전 default는 OFF, 호출자 명시
- **세션 풀 크기 무제한** — 호스트 PC가 PTY 100개 띄우면 죽음. 상한 + LRU eviction
- **claude CLI 절대 경로 하드코딩** — `which claude` / `where claude` / 환경변수
