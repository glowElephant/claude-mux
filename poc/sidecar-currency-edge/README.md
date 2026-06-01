# PoC sidecar — currency-edge

`currency-edge` 봇의 `claude -p` 호출 4곳 중 1곳(`discord_bot.ask_claude`)의 호출 패턴을
`@claude-mux/client`로 흉내. **봇 자체에는 영향 0**.

## 목적

v0.1.3까지 만든 muxd가 currency-edge의 실제 prompt 패턴(assistant prompt + 컨텍스트 + 질문)을
처리 가능한지 검증. 데몬 자동 spawn → ask → 응답 round-trip 시간 측정.

## 실행

```bash
# 코드만 검증 (claude 호출 안 함)
MUX_SIDECAR_DRY=1 node poc/sidecar-currency-edge/sidecar.mjs

# 실제 호출 — claude PTY 한 번 띄우고 응답 받음 (~25초, 봇 한도 1회 소비)
node poc/sidecar-currency-edge/sidecar.mjs

# 질문 변경
MUX_SIDECAR_QUESTION="현재 슬롯 P/L 한 줄로 요약" node poc/sidecar-currency-edge/sidecar.mjs
```

## 격리

- cwd는 PoC 폴더로 명시 → `~/.claude/projects/C--Git-currency-edge`에 새 jsonl 안 만듦
- 데몬은 사이드카가 띄운 게 살아남음 — `muxd stop`으로 종료
- 봇 프로세스/cookies/jsonl 일체 안 건드림

## 결과 (2026-05-31, server PC)

### ✓ auto-spawn 동작 확인
`MUXD_BIN=$(pwd)/node_modules/.bin/muxd.cmd`로 실행 — 데몬 자동으로 띄움, 클라이언트 정상 연결.

### ✗ 실제 ask는 stall (90s idle 사망)
discord_bot 스타일 prompt(216자, assistant prompt + 컨텍스트 + 질문)로 호출 시:
```
✗ failed after 89935ms: Session ...: no PTY output for 60000ms — assumed dead/stuck
```

D 단계 통합 테스트(`'respond with exactly: "OK-AUTOMATION"'` 50자)는 18초 정상 응답한 것과 대조.

### 가설 (v0.2.0에서 정밀 진단)
- **prompt 길이/형식 영향**: 200자 넘는 multi-section prompt에서 자동화 system prompt 룰("Output ONLY the final answer text. No preamble.") 따라 모델이 균형 못 잡고 stall
- **system-prompt 회귀와 같은 양상**: 어떤 system context 추가/변경이든 모델이 전반 멈추는 패턴(#13과 같음)
- **현실적 대응**: currency-edge 측 prompt 단순화 + claude-mux 측 idleDeathMs 동적 조정(긴 prompt에서 더 길게)

### 후속 진단 (v0.1.4 — `MUX_SIDECAR_SIMPLE=1`)

- ✓ **단순 prompt(57자)**: 13.5초 정상 응답 (`OK-SIDECAR-CURRENCY-EDGE`)
- ✗ **discord_bot multi-section prompt(216자)**: idleDeathMs를 60s → 180s로 늘려도 동일하게 stall
- → stall은 timeout 문제 아님. PTY 출력 자체가 한 글자도 안 옴 = 모델이 응답 시작 자체를 안 함

### 확정 결론

| 부품 | 상태 |
|---|---|
| muxd 데몬 + JSON-RPC + auto-spawn | ✅ 정상 |
| Client.ask round-trip | ✅ 정상 |
| cwd 격리 (`poc/sidecar-currency-edge/`) | ✅ 정상 |
| `idleDeathMs` / `detectFailure` 옵션 | ✅ 정상 |
| **discord_bot 스타일 multi-section prompt** | ❌ **stall 유발** |

stall 원인은 **prompt 패턴**. `system prompt(자동화 룰) + user input 첫줄 "You are the bot's assistant..." + ## 헤더 + 컨텍스트 + 질문` 조합에서 모델이 응답 생성을 시작하지 못함. system-prompt 변경 회귀(#13)와 동일 양상.

### v0.2.0 마이그레이션 권장사항

1. **currency-edge 측 prompt 단순화** — assistant prompt를 system prompt에 흡수 (muxd가 system context 주입함). 첫 user message는 컨텍스트 + 질문만.
2. **`##` 마크다운 헤더 회피** — flat text로 컨텍스트 + 질문 결합.
3. **prompt 길이 < 150자** 권장 (현재 정상 동작 확인 범위).
4. 위 1~3 적용한 prompt로 사이드카 재실행 → 통과 확인 → 본 마이그레이션 진입.

---

## F-1 정밀 검증 — split 패턴 시도 결과

prompt 패턴을 좁히기 위해 5가지 모드를 차례로 시도. 봇 한도 약 14분 소비.

| # | 모드 | prompt | timeout | 결과 |
|---|---|---|---|---|
| 1 | `MUX_SIDECAR_SIMPLE=1` | `respond with exactly one line: 'OK-...'` (57자) | 60s | ✅ **13.5초** |
| 2 | default (멀티섹션) | discord_bot 패턴 4섹션 (216자) | 60s | ❌ 90s stall |
| 3 | `SPLIT=1` (정보 통보) | `Currency bot context: Slot 0...` (75자) | 60s | ❌ 120s stall |
| 4 | `SPLIT=1` (정보+명령) | `Bot status: Slot 0... Reply 'noted'` (111자, automation) | 120s | ❌ 120s stall |
| 5 | `SPLIT=1` chat 모드 | 동일 (111자, chat) | 240s | ❌ 240s stall |
| 6 | `SPLIT=1` minimal | msg1 `Bot is running. Reply 'noted'` (60자) + msg2 `Given that bot status, respond with...` (80자) | 240s | ✅ msg1 11.3s / ❌ msg2 240s |

### 확정된 통과 패턴

- ✅ **standalone 명령형** — 한 메시지에 명령만, 이전 컨텍스트 참조 없음
- ✅ **명령형 + 단순 정보** ("Bot is running. Reply 'noted'.") — automation 모드 OK

### 확정된 stall 패턴

- ❌ **referential prefix** ("Given that ...", "Based on the above ...") — automation 모드의 `Don't ask clarifying` 룰과 충돌
- ❌ **금융 텍스트 + 멀티섹션** (discord_bot 원본 패턴) — 위와 같은 원인
- ❌ **`##` 마크다운 헤더 multi-section**

### v0.2.0 마이그레이션에 사용할 패턴 (가설)

```python
# Python 측 prompt 구성 — 매 호출이 standalone 명령형
prompt = f"Bot status is: {status_summary}. Question: {user_question}. Reply with answer to the question in one line under 200 chars."
result = client.ask(prompt, cwd=..., mode="automation", idle_death_ms=120_000)
```

- 컨텍스트 inline (동일 메시지)
- referential prefix 없음 ("Given", "Based on" 등 금지)
- 마지막에 명확한 액션 동사 + 출력 형식
- 길이 < 200자 권장 (안전 마진)

⚠️ **본 패턴은 currency-edge 실제 prompt에서 추가 검증 필요** (아래 like-discord 결과 참조).

---

## L-2 검증 — discord_bot 패턴 직접 시도

`MUX_SIDECAR_LIKE_DISCORD=1` 모드로 currency-edge `discord_bot._build_muxd_prompt`와
동일한 형식의 prompt를 사이드카에서 실행.

```
환율 봇 어시스턴트로서 답해. 봇 상태: Slot 0: USD/KRW @ 1380.50 (running 12m) P/L: +0.03%.
사용자 질문: respond with exactly one line: 'OK-SIDECAR-CURRENCY-EDGE'.
답을 한국어로 1900자 이내 한 문단으로 작성해.
```

| 항목 | 값 |
|---|---|
| 길이 | 171자 (PoC 권장 < 200자 안) |
| 모드 | automation |
| 패턴 | standalone imperative inline (referential prefix 없음) |
| 결과 | ❌ **120s idle stall** |

### 분석 — 봇 상태 inline이 핵심 stall 원인 가능성

K-1 통과 패턴(60자): `"Bot is running. Reply with exactly 'noted' and nothing else."`
- ✅ 영어 + 금융 텍스트 없음 + 단일 명령
- 통과 11.3초

like-discord 실패(171자):
- ❌ 한국어/영어 혼합 + **봇 상태 inline** (`USD/KRW @ 1380.50`)

차이점은 봇 상태 + 통화/숫자/특수문자(`@`, `:`, `/`, `%`) 조합. F-1 단계에서도 같은
종류의 prompt가 stall했음.

### currency-edge 마이그레이션 함의

discord_bot의 실제 운영 prompt는 봇 상태 정보(환율/슬롯/P&L) 없이는 의미 있는 답변
어려움. 그게 들어가면 muxd에서 stall.

**현재 권장**:
- USE_MUXD=1 활성화 보류
- 모델 stall 우회 방법 추가 연구 (#13, #3)
- 인프라(USE_MUXD 토글)는 머지 완료 — 미래 활성화 준비됨

---

## 🎯 file-ref 패턴 통과 + muxd 버그 발견 (v0.1.6)

이전 결론("어떤 prompt 패턴이든 stall")이 **틀렸음**. 실제 원인 두 가지:

### 1. muxd 버그 (v0.1.5까지)
`session-tail`이 `stop_reason: "tool_use"`도 응답 완료로 처리 → 모델이 도구만 호출했는데 muxd는 "끝났네" 판단 → 호출자에 **빈 응답 즉시 반환**.

### 2. file-ref 패턴 (사용자 제안)
prompt에 봇 상태/금융 텍스트 inline 대신 **파일로 분리**, prompt는 짧은 명령 ("Read ctx.txt and reply briefly.") + `allowedTools: "Read"`.

### MUX_SIDECAR_FILE_REF=1 결과

```
$ MUX_SIDECAR_FILE_REF=1 node poc/sidecar-currency-edge/sidecar.mjs

[sidecar:file-ref] ctx file: C:\Git\claude-mux\poc\sidecar-currency-edge\ctx.txt
[sidecar:file-ref] ctx body length: 212 chars
[sidecar:file-ref] prompt length: 31 chars
[sidecar:file-ref] prompt: Read ctx.txt and reply briefly.
[sidecar] ✓ done in 17125ms
---
봇 상태 요약: 슬롯 0에서 12분째 가동 중, 환율 1380.50원, P&L +0.03%.
---
```

17.1초만에 한국어 자연스러운 응답, 봇 상태 정확 인용 (`1380.50`, `P&L`, `+0.03%` 특수문자 포함).

### 진단으로 정정된 가설

| 항목 | 이전 추정 | 실제 |
|---|---|---|
| stall 원인 | 봇 상태/금융 텍스트/특수문자 inline | muxd가 tool_use에서 일찍 done |
| 멀티섹션 stall | prompt 길이/형식 | 모델이 도구 호출 시도 → muxd 떠남 |
| L-2 like-discord 실패 | 한국어/영어 혼합 | 같은 muxd 버그 |
| K-1 통과 (60자, 도구 없음) | 짧아서 통과 | end_turn 정상 stop_reason → 통과 |

### currency-edge 마이그레이션 패턴 (확정)

```python
# discord_bot.py 권장 prompt 구성 (v0.1.6 muxd 사용 시)
import tempfile, os
from pathlib import Path

def _build_muxd_prompt(question, context, user_id=""):
    # 1. 컨텍스트를 임시 파일에 저장
    ctx_path = Path(tempfile.gettempdir()) / f"discord-ctx-{user_id or 'anon'}.txt"
    ctx_path.write_text(
        f"# Bot context\n{context}\n\n# User question\n{question}\n",
        encoding="utf-8",
    )
    # 2. prompt는 짧게 — Read 도구로 모델이 읽음
    return f"Read {ctx_path} and answer the user question briefly in Korean."

# Client.ask 시 allowed_tools="Read" 명시 필수
client.ask(
    prompt,
    cwd=...,
    mode="automation",
    allowed_tools="Read",
    idle_death_ms=120_000,
)
```

