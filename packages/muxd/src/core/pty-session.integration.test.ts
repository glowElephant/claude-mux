/**
 * 통합 테스트 — 실제 claude CLI를 PTY로 띄워서 동작 검증.
 *
 * 환경:
 *  - CLAUDE_CLI 가 있거나 claude가 PATH에 있어야 동작
 *  - 호스트가 Claude 로그인된 상태
 *
 * 실패 시 skip하지 않고 명시적으로 fail — CI/로컬 둘 다 진실을 보여줘야 함.
 * 환경 부재로 진짜 못 돌리는 경우만 옵트인 (MUX_INTEGRATION=1) 으로 분리.
 */

import { describe, it, expect, afterEach } from "vitest";
import { PtySession } from "./pty-session.js";
import { BlockedError } from "./errors.js";

const ENABLED = process.env.MUX_INTEGRATION === "1";
const d = ENABLED ? describe : describe.skip;

/** PTY 인터랙티브는 사람 속도. 테스트 간 5초 cooldown으로 자원 정리 보장. */
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 5_000));
});

d("PtySession integration (real claude CLI)", () => {
  it(
    "automation: open + send + close 1 round-trip",
    async () => {
      const s = new PtySession({
        cwd: process.cwd(),
        invoker: "muxd-integration-test",
        mode: "automation",
      });
      try {
        await s.init({});
        const reply = await s.send(
          'respond with exactly: "OK-AUTOMATION"',
          { idleDeathMs: 60_000, maxMs: 120_000 },
        );
        expect(reply).toMatch(/OK-AUTOMATION/);
      } finally {
        await s.close();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "automation: serialized 3 messages on same session",
    async () => {
      const s = new PtySession({
        cwd: process.cwd(),
        invoker: "muxd-integration-test",
        mode: "automation",
      });
      try {
        await s.init({});
        // 병렬로 send — PtySession이 큐로 직렬 처리해야 함
        const [a, b, c] = await Promise.all([
          s.send('reply with exactly: "one"', { idleDeathMs: 60_000, maxMs: 120_000 }),
          s.send('reply with exactly: "two"', { idleDeathMs: 60_000, maxMs: 120_000 }),
          s.send('reply with exactly: "three"', { idleDeathMs: 60_000, maxMs: 120_000 }),
        ]);
        expect(a).toMatch(/one/);
        expect(b).toMatch(/two/);
        expect(c).toMatch(/three/);
      } finally {
        await s.close();
      }
    },
    { timeout: 240_000 },
  );

  // v0.1.3: matchBlocked 인프라가 XML 형식(<mux:blocked>)도 매치 — 단위 테스트로 검증됨.
  // 실제 모델 트리거는 system-prompt 어떤 변경이든 통합 전체 회귀시킴 (이전 5개 통과 케이스도 stall).
  // 모델 행동 자체가 약속어 사용을 거부하는 듯 — 별도 마일스톤 #13으로 계속 연구.
  it.skip(
    "automation: send() throws BlockedError on impossible question (model refuses — see #13)",
    async () => {
      const s = new PtySession({
        cwd: process.cwd(),
        invoker: "muxd-integration-test",
        mode: "automation",
      });
      try {
        await s.init({});
        await expect(
          s.send(
            "What was the closing exchange rate of USD to KRW on 2030-12-31?",
            { idleDeathMs: 60_000, maxMs: 120_000 },
          ),
        ).rejects.toBeInstanceOf(BlockedError);
      } finally {
        await s.close();
      }
    },
    { timeout: 120_000 },
  );
});
