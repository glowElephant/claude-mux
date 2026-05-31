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

