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

import { describe, it, expect } from "vitest";
import { PtySession } from "./pty-session.js";

const ENABLED = process.env.MUX_INTEGRATION === "1";
const d = ENABLED ? describe : describe.skip;

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

  // 비결정적 — Claude가 시뮬레이션을 따르지 않고 실제 도구 호출로 빠지면 실패.
  // 별도 이슈에서 결정적 프롬프트 설계 필요.
  it.skip(
    "MUX_BLOCKED token is returned when Claude judges impossible (automation)",
    async () => {
      const s = new PtySession({
        cwd: process.cwd(),
        invoker: "muxd-integration-test",
        mode: "automation",
      });
      try {
        await s.init({});
        const reply = await s.send(
          "You have no internet. Get the current real-time stock price of AAPL. " +
            "If you cannot, use the MUX_BLOCKED token as instructed.",
          { idleDeathMs: 60_000, maxMs: 120_000 },
        );
        // 너무 빡빡한 검증은 모델 행동에 따라 흔들림 — 토큰 등장만 확인
        expect(reply).toMatch(/MUX_BLOCKED/);
      } finally {
        await s.close();
      }
    },
    { timeout: 120_000 },
  );
});
