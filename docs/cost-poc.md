# PoC 비용 측정 결과

> Phase 0의 핵심 검증: PTY로 `claude` 인터랙티브 모드를 spawn해서 메시지를 주고받을 때, 실제로 헤드리스 크레딧이 차감되지 않는지.

## 측정 방법

1. Anthropic 콘솔(`claude.ai/settings/billing` 또는 동등 위치)에서 현재 크레딧/사용량 스냅샷
2. `poc/pty-roundtrip.mjs` 1회 실행
3. 콘솔 새로고침 → 변화 확인
4. `poc/pty-many.mjs 10` 실행 (10회 메시지)
5. 다시 확인
6. `poc/pty-many.mjs 100` 실행
7. 최종 확인

비교 기준선:
- `claude -p "ping"` 1회 헤드리스 호출 직접 실행 → 차감액 측정
- PTY 모드와 비교

## 결과

### Round 1 — `pty-roundtrip.mjs` (1회)
- 일시: 2026-05-25
- 환경: Windows 11, Node.js, `node-pty` v1, Claude Code v2.1.150, Max 구독
- 프롬프트: `"respond with exactly: PONG-OK"`
- 응답: `PONG-OK` 정상 캡처
- TUI 인증: `Opus 4.7 (1M context) | Claude Max · gksdk1029@...`
- **사용량 카운터 (TUI 우측 하단)**: `5시간: 20% (0h7m) / 7일: 38% (2d11h)`
- **헤드리스 크레딧 변화: 없음** (TUI 사용량으로만 차감, 구독 한도 윈도우 카운터)
- 결론: **PTY 인터랙티브 = 사람이 직접 켜고 쓰는 것과 동일하게 메터링** → 헤드리스 크레딧 풀 별개

### Round 2 — `pty-many.mjs 10`
- 일시: TBD
- ...

### Round 3 — `pty-many.mjs 100`
- 일시: TBD
- ...

### Baseline — `claude -p "ping"` 헤드리스 직접 호출
- 일시: TBD
- 차감액: TBD

## 결론 (잠정 — 2026-05-25)

| 시나리오 | 헤드리스 크레딧 차감? | 비고 |
|---|---|---|
| `claude -p` 직접 | YES (정책 변경 6/15 이후) | 별도 크레딧 풀 소진 |
| PTY 인터랙티브 1회 | **NO** | 구독 5시간/7일 윈도우 카운터로만 |
| PTY 인터랙티브 N회 (같은 세션) | NO (예상, Round 2 측정 필요) | |
| PTY 인터랙티브 N회 (N개 세션 동시) | NO (예상, Round 3 측정 필요) | |

**잠정 결론**: 구독 한도 윈도우만 신경 쓰면 됨. Pro/Max 한도 안에서 N개 세션 자유.

## 알게 된 부수 사실
- TUI 출력 우측 하단에 `5시간: X% (Hm) / 7일: X% (Dh)` 카운터 표시됨 → 데몬이 이 값을 정기 캡처해서 호스트에게 노출 가능 (`mux.usage()`)
- TUI에 `Opus 4.7 (1M context) | Claude Max · <email>` 라인이 있음 → 인증 상태 검증 가능
- ANSI 출력에서 응답 텍스트 추출은 가능하나 노이즈 많음 → 전용 파서 필요 (단순 stripAnsi로는 불충분)

## 다음 단계
- [x] Round 1 통과 → v0.1.0 진행 승인
- [ ] Round 2: `pty-many 10` 측정
- [ ] Round 3: 다중 세션 동시
- [ ] 응답 추출 파서 강화 (TUI 프롬프트/스피너/푸터 제거)
