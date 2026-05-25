#!/usr/bin/env node
/**
 * PoC #2 — Same PTY session, N sequential messages.
 *
 * Goal: verify that one interactive `claude` PTY can serve many messages
 * (reusing context) without triggering headless billing.
 *
 * Run: node pty-many.mjs 10
 *
 * Watch the Anthropic console (claude.ai/settings/billing) before/after
 * and record results in ../docs/cost-poc.md
 */

import pty from "node-pty";
import stripAnsiMod from "strip-ansi";
import os from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const stripAnsi = stripAnsiMod.default ?? stripAnsiMod;

const N = parseInt(process.argv[2] ?? "5", 10);
console.error(`[poc] will send ${N} messages on one PTY session`);

function locateClaude() {
  if (process.env.CLAUDE_CLI && existsSync(process.env.CLAUDE_CLI)) return process.env.CLAUDE_CLI;
  const home = os.homedir();
  const cand = path.join(home, ".local", "bin", os.platform() === "win32" ? "claude.exe" : "claude");
  if (existsSync(cand)) return cand;
  const out = execSync(os.platform() === "win32" ? "where claude" : "which claude", { encoding: "utf8" });
  return out.split(/\r?\n/).find(Boolean);
}

const env = { ...process.env };
delete env.CLAUDECODE;

const proc = pty.spawn(locateClaude(), [], {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: process.cwd(),
  env,
});

let buf = "";
let lastDataAt = Date.now();
proc.onData((d) => {
  buf += d;
  lastDataAt = Date.now();
});

function waitIdle(ms = 4000, hardMax = 60000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (Date.now() - lastDataAt >= ms) { clearInterval(iv); resolve(); }
      if (Date.now() - start >= hardMax) { clearInterval(iv); resolve(); }
    }, 250);
  });
}

async function main() {
  console.error("[poc] waiting for TUI to boot...");
  await new Promise((r) => setTimeout(r, 2500));
  buf = ""; // 부팅 출력 버림

  for (let i = 1; i <= N; i++) {
    const msg = `ping ${i}/${N} — reply with just "pong ${i}" and nothing else`;
    const before = buf.length;
    console.error(`\n[poc] [${i}/${N}] sending: ${msg}`);
    proc.write(msg + "\r");
    await waitIdle(3500);
    const reply = stripAnsi(buf.slice(before));
    console.error(`[poc] [${i}/${N}] reply bytes: ${buf.length - before}`);
    const pongLine = reply.split(/\r?\n/).find((l) => /pong\s*\d/i.test(l));
    console.error(`[poc] [${i}/${N}] extracted: ${pongLine ?? "(no pong line found)"}`);
  }

  console.error(`\n[poc] done. closing PTY.`);
  proc.kill();
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error(e); process.exit(1); });
