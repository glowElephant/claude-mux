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

### 다음
v0.2.0(Python 클라이언트 + 실제 마이그레이션) 진입 전에 prompt 패턴별 stall 매트릭스를 issue #3에서 측정.

