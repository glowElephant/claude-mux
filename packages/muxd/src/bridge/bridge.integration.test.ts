/**
 * Bridge API 통합 테스트 — 실제 claude CLI 사용.
 */

import { describe, it, expect, afterEach } from "vitest";
import { ask, openSession, stream } from "./index.js";

const ENABLED = process.env.MUX_INTEGRATION === "1";
const d = ENABLED ? describe : describe.skip;

/**
 * PTY 인터랙티브는 사람 속도 인터페이스. 테스트 간 자연 cooldown을 두어
 * claude CLI / ConPTY가 직전 인스턴스를 정리할 시간을 보장한다.
 * (운영 가정: docs/spec.md "Operating envelope" 참조)
 */
const SPAWN_COOLDOWN_MS = 5_000;
afterEach(async () => {
  await new Promise((r) => setTimeout(r, SPAWN_COOLDOWN_MS));
});

d("bridge.ask (single-shot)", () => {
  it(
    "returns exact reply for automation mode",
    async () => {
      const text = await ask('reply with exactly: "BRIDGE-ASK-OK"', {
        cwd: process.cwd(),
        invoker: "bridge-test",
        idleDeathMs: 60_000,
        maxMs: 120_000,
      });
      expect(text).toMatch(/BRIDGE-ASK-OK/);
    },
    { timeout: 120_000 },
  );
});

d("bridge.openSession (reusable)", () => {
  it(
    "2 sequential sends on same session both return correct replies",
    async () => {
      const s = await openSession({
        cwd: process.cwd(),
        invoker: "bridge-session-test",
        mode: "automation",
      });
      try {
        const a = await s.send('reply with exactly: "FIRST"', {
          idleDeathMs: 60_000,
          maxMs: 120_000,
        });
        expect(a).toMatch(/FIRST/);
        const b = await s.send('reply with exactly: "SECOND"', {
          idleDeathMs: 60_000,
          maxMs: 120_000,
        });
        expect(b).toMatch(/SECOND/);
      } finally {
        await s.close();
      }
    },
    { timeout: 240_000 },
  );
});

d("bridge.stream", () => {
  it(
    "yields at least one chunk containing the reply",
    async () => {
      const chunks: string[] = [];
      for await (const c of stream('reply with exactly: "STREAM-OK"', {
        cwd: process.cwd(),
        invoker: "bridge-stream-test",
        idleDeathMs: 60_000,
        maxMs: 120_000,
      })) {
        chunks.push(c);
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join("")).toMatch(/STREAM-OK/);
    },
    { timeout: 120_000 },
  );
});
