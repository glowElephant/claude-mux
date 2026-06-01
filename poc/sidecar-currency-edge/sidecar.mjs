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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRY = process.env.MUX_SIDECAR_DRY === "1";
/**
 * 모드:
 *   default: discord_bot 멀티섹션 패턴 그대로 (stall 재현용)
 *   SIMPLE=1: 단순 prompt 단발 (muxd 자체 정상 동작 확인용)
 *   SPLIT=1: 분리 패턴 — openSession + 컨텍스트 send + 질문 send (F-1 본 검증)
 */
const SIMPLE = process.env.MUX_SIDECAR_SIMPLE === "1";
const SPLIT = process.env.MUX_SIDECAR_SPLIT === "1";
const LIKE_DISCORD = process.env.MUX_SIDECAR_LIKE_DISCORD === "1";
const FILE_REF = process.env.MUX_SIDECAR_FILE_REF === "1";
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

async function runDefault(client) {
  console.log(`[sidecar:default] prompt length: ${FULL_PROMPT.length} chars`);
  const t0 = Date.now();
  const text = await client.ask(FULL_PROMPT, {
    cwd: __dirname,
    invoker: "currency-edge-sidecar-poc",
    mode: "automation",
    idleDeathMs: 180_000,
    maxMs: 240_000,
    detectFailure: true,
  });
  return { text, dt: Date.now() - t0 };
}

/**
 * FILE_REF 모드 — 사용자 제안 우회 패턴.
 * 봇 상태 + 질문을 임시 파일에 쓰고, prompt에는 짧은 "Read X and answer" 명령만.
 *
 * 가설: stall 핵심 원인 = prompt에 봇 상태/금융 텍스트 포함.
 * 우회: 파일에 넣고 Read 도구로 모델이 직접 가져가게.
 * allowedTools="Read"로 automation 모드에서도 Read 허용.
 */
async function runFileRef(client) {
  // O-2: 컨텍스트 자연어화 — 특수문자(@, /, %, :) 모두 제거.
  // 가설: 봇 상태에 금융 표기 특수문자가 모델 응답 stall 유발.
  const ctxPath = path.join(__dirname, "ctx.txt");
  const fileBody =
    "Currency bot context\n" +
    "Bot is running on slot zero. Exchange rate is 1380 won 50 cents. " +
    "Running for 12 minutes. Profit and loss is 0.03 percent.\n\n" +
    "User question\n" +
    "Reply with one short line summarizing the bot status.\n";
  fs.writeFileSync(ctxPath, fileBody, "utf8");

  const prompt = `Read ctx.txt and reply briefly.`;
  console.log(`[sidecar:file-ref] ctx file: ${ctxPath}`);
  console.log(`[sidecar:file-ref] ctx body length: ${fileBody.length} chars`);
  console.log(`[sidecar:file-ref] prompt length: ${prompt.length} chars`);
  console.log(`[sidecar:file-ref] prompt: ${prompt}`);

  const t0 = Date.now();
  try {
    const text = await client.ask(prompt, {
      cwd: __dirname,
      invoker: "currency-edge-file-ref-poc",
      mode: "automation",
      allowedTools: "Read",
      idleDeathMs: 120_000,
      maxMs: 180_000,
      detectFailure: true,
    });
    return { text, dt: Date.now() - t0 };
  } finally {
    try {
      fs.unlinkSync(ctxPath);
    } catch {}
  }
}

/**
 * LIKE_DISCORD 모드 — discord_bot.py:_build_muxd_prompt와 같은 형식.
 * standalone imperative inline, 한국어 명령형, 마크다운 없음, 컨텍스트 한 줄.
 */
async function runLikeDiscord(client) {
  const ctxOneline = FAKE_CONTEXT.split("\n").map(s => s.trim()).filter(Boolean).join(" ");
  const prompt =
    "환율 봇 어시스턴트로서 답해." +
    ` 봇 상태: ${ctxOneline}.` +
    ` 사용자 질문: ${QUESTION}.` +
    " 답을 한국어로 1900자 이내 한 문단으로 작성해.";
  console.log(`[sidecar:like-discord] prompt length: ${prompt.length} chars`);
  console.log(`[sidecar:like-discord] prompt preview: ${prompt.slice(0, 120)}...`);
  const t0 = Date.now();
  const text = await client.ask(prompt, {
    cwd: __dirname,
    invoker: "currency-edge-discord-bot",
    mode: "automation",
    idleDeathMs: 120_000,
    maxMs: 180_000,
    detectFailure: true,
  });
  return { text, dt: Date.now() - t0 };
}

async function runSimple(client) {
  console.log(`[sidecar:simple] prompt length: ${FULL_PROMPT.length} chars`);
  const t0 = Date.now();
  const text = await client.ask(FULL_PROMPT, {
    cwd: __dirname,
    invoker: "currency-edge-sidecar-poc",
    mode: "automation",
    idleDeathMs: 180_000,
    maxMs: 240_000,
    detectFailure: true,
  });
  return { text, dt: Date.now() - t0 };
}

/**
 * SPLIT 패턴 — discord_bot의 멀티섹션 prompt를 두 번의 send로 분리.
 *   1. openSession (mode=automation, invoker=...) — system context 자동 주입
 *   2. send(컨텍스트) — flat text, markdown 헤더 없음
 *   3. send(질문) — 짧게
 *   4. close
 *
 * 봇 한도 = 2 round-trip (~30~40s 예상).
 */
async function runSplit(client) {
  // K-1: 금융/숫자/특수문자 완전 제거. 가설 검증 — 그게 stall 원인인지.
  console.log(`[sidecar:split] minimal plain-english (K-1)`);
  const t0 = Date.now();
  const sess = await client.openSession({
    cwd: __dirname,
    invoker: "currency-edge-discord-bot",
    mode: "automation",
  });
  try {
    const msg1 = `Bot is running. Reply with exactly 'noted' and nothing else.`;
    console.log(`[sidecar:split] msg 1 (${msg1.length} chars): ${msg1}`);
    const ack = await sess.send(msg1, {
      idleDeathMs: 240_000,
      maxMs: 300_000,
      detectFailure: true,
    });
    const dt1 = Date.now() - t0;
    console.log(`[sidecar:split] ✓ msg 1 (${dt1}ms): ${ack.slice(0, 80)}`);

    const t1 = Date.now();
    const msg2 = `Given that bot status, ${QUESTION}`;
    console.log(`[sidecar:split] msg 2 (${msg2.length} chars): ${msg2}`);
    const reply = await sess.send(msg2, {
      idleDeathMs: 240_000,
      maxMs: 300_000,
      detectFailure: true,
    });
    const dt2 = Date.now() - t1;
    console.log(`[sidecar:split] ✓ msg 2 (${dt2}ms)`);
    return { text: reply, dt: Date.now() - t0 };
  } finally {
    await sess.close().catch(() => {});
  }
}

async function main() {
  console.log("[sidecar] PoC start");
  const mode = FILE_REF
    ? "file-ref"
    : LIKE_DISCORD
    ? "like-discord"
    : SPLIT
    ? "split"
    : SIMPLE
    ? "simple"
    : "default";
  console.log(`[sidecar] mode: ${mode}`);
  console.log(`[sidecar] DRY: ${DRY}`);

  if (DRY) {
    console.log("[sidecar] DRY mode — skipping real claude call");
    if (mode === "file-ref") {
      const previewPath = path.join(__dirname, "ctx.txt");
      const fileBody =
        "# Currency bot context\n" + FAKE_CONTEXT + "\n\n# User question\n" + QUESTION + "\n";
      const previewPrompt = "Read ctx.txt and reply briefly.";
      console.log(`[sidecar:file-ref] would write ctx file: ${previewPath}`);
      console.log(`[sidecar:file-ref] ctx body length: ${fileBody.length} chars`);
      console.log(`[sidecar:file-ref] prompt length: ${previewPrompt.length} chars`);
      console.log(`[sidecar:file-ref] prompt: ${previewPrompt}`);
    } else if (mode === "like-discord") {
      const ctxOneline = FAKE_CONTEXT.split("\n").map(s => s.trim()).filter(Boolean).join(" ");
      const previewPrompt =
        "환율 봇 어시스턴트로서 답해." +
        ` 봇 상태: ${ctxOneline}.` +
        ` 사용자 질문: ${QUESTION}.` +
        " 답을 한국어로 1900자 이내 한 문단으로 작성해.";
      console.log(`[sidecar:like-discord] prompt length: ${previewPrompt.length} chars`);
      console.log(`[sidecar:like-discord] preview:`);
      console.log(previewPrompt);
    } else if (mode === "split") {
      console.log(`[sidecar] split would send 2 messages:`);
      console.log(`  1) context (~60 chars)`);
      console.log(`  2) question (~${QUESTION.length} chars)`);
    } else {
      console.log("[sidecar] prompt preview (first 200 chars):");
      console.log(FULL_PROMPT.slice(0, 200) + "...");
    }
    return;
  }

  const client = new Client({});
  try {
    const run =
      mode === "file-ref"
        ? runFileRef
        : mode === "like-discord"
        ? runLikeDiscord
        : mode === "split"
        ? runSplit
        : mode === "simple"
        ? runSimple
        : runDefault;
    const { text, dt } = await run(client);
    console.log(`[sidecar] ✓ done in ${dt}ms`);
    console.log("---");
    console.log(text);
    console.log("---");
  } catch (err) {
    console.error(`[sidecar] ✗ failed:`, err.message);
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
