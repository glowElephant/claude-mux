#!/usr/bin/env node
/**
 * PoC sidecar — currency-edge의 discord_bot.ask_claude 호출 패턴을
 * @claude-mux/client로 흉내 (봇 자체는 안 건드림).
 *
 * 검증:
 *  1. v0.1.3 muxd 데몬을 사이드카가 자동으로 띄움 (autoSpawn)
 *  2. discord_bot과 동일한 형태의 prompt (assistant prompt + 컨텍스트 + 질문) 보냄
 *  3. 응답 받아서 콘솔 출력
 *  4. PTY 비용 측정 — `claude -p` 대신 데몬을 거치는 것의 round-trip 시간
 *
 * 봇 자체에는 영향 0 — currency-edge의 process/jsonl/cookies 다 안 건드림.
 * cwd는 일부러 PoC 폴더로 설정 (currency-edge 디렉토리 jsonl 새로 만들지 않음).
 *
 * 환경:
 *   MUX_SIDECAR_DRY=1  → 데몬 호출 안 함 (코드만 검증)
 *   MUX_SIDECAR_QUESTION="..."  → 질문 오버라이드
 *
 * 실행:
 *   node poc/sidecar-currency-edge/sidecar.mjs
 */

import { Client } from "@claude-mux/client";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRY = process.env.MUX_SIDECAR_DRY === "1";
/**
 * SIMPLE=1: discord_bot 패턴 prompt 우회 — D 통합 테스트와 같은 단순 prompt만 보냄.
 * stall이 prompt 패턴 영향인지 muxd 자체 영향인지 분리 진단용.
 */
const SIMPLE = process.env.MUX_SIDECAR_SIMPLE === "1";
const QUESTION =
  process.env.MUX_SIDECAR_QUESTION ??
  "respond with exactly one line: 'OK-SIDECAR-CURRENCY-EDGE'";

// discord_bot.ask_claude의 prompt 패턴 재현 (단순화):
//   - assistant prompt (시스템 가이드)
//   - 봇 상태 컨텍스트
//   - 사용자 질문
const ASSISTANT_PROMPT =
  "You are the currency-edge bot's assistant. Reply concisely.";
const FAKE_CONTEXT = "Slot 0: USD/KRW @ 1380.50 (running 12m)\nP/L: +0.03%";
const FULL_PROMPT = SIMPLE
  ? QUESTION // D 통합 테스트와 동일한 단순 형태
  : [
      ASSISTANT_PROMPT,
      `\n## 현재 봇 상태\n\`\`\`\n${FAKE_CONTEXT}\n\`\`\`\n`,
      `\n## 사용자 질문\n${QUESTION}\n\n2000자 이내로 답해.`,
    ].join("\n");

async function main() {
  console.log("[sidecar] PoC start");
  console.log(`[sidecar] DRY=${DRY}`);
  console.log(`[sidecar] prompt length: ${FULL_PROMPT.length} chars`);

  if (DRY) {
    console.log("[sidecar] DRY mode — skipping real claude call");
    console.log("[sidecar] prompt preview (first 200 chars):");
    console.log(FULL_PROMPT.slice(0, 200) + "...");
    return;
  }

  const client = new Client({
    // autoSpawn=true 기본 — 데몬 없으면 자동 띄움
  });

  const t0 = Date.now();
  try {
    const text = await client.ask(FULL_PROMPT, {
      cwd: __dirname, // 일부러 PoC 폴더 — currency-edge jsonl 디렉토리에 새 파일 안 만듦
      invoker: "currency-edge-sidecar-poc",
      mode: "automation",
      idleDeathMs: 180_000, // v0.1.4: 긴 prompt 대응 60s → 180s
      maxMs: 240_000,
      detectFailure: true, // 자연어 거부 표현이면 BlockedError throw
    });
    const dt = Date.now() - t0;
    console.log(`[sidecar] ✓ response (${dt}ms):`);
    console.log("---");
    console.log(text);
    console.log("---");
  } catch (err) {
    const dt = Date.now() - t0;
    console.error(`[sidecar] ✗ failed after ${dt}ms:`, err.message);
    if (err.code === "BLOCKED") {
      console.error(`[sidecar]   blocked reason: ${err.reason}`);
    }
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error("[sidecar] fatal:", e);
  process.exit(1);
});
