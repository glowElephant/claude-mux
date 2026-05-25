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
- 일시: TBD
- 실행 전 크레딧 사용량: TBD
- 실행 후 크레딧 사용량: TBD
- 차감 발생: TBD (yes / no / unknown)
- 메모: TBD

### Round 2 — `pty-many.mjs 10`
- 일시: TBD
- ...

### Round 3 — `pty-many.mjs 100`
- 일시: TBD
- ...

### Baseline — `claude -p "ping"` 헤드리스 직접 호출
- 일시: TBD
- 차감액: TBD

## 결론

(채워질 예정)

| 시나리오 | 헤드리스 크레딧 차감? |
|---|---|
| `claude -p` 직접 | YES (예상) |
| PTY 인터랙티브 1회 | TBD |
| PTY 인터랙티브 100회 | TBD |

## 다음 단계

- 차감 없음 확인 → v0.1.0 MVP 본 개발 진행
- 차감 발생 → 프로젝트 보류, 정책/방법 재검토 (Agent SDK, MCP 등)
