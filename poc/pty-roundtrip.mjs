#!/usr/bin/env node
/**
 * PoC #1 — Minimal PTY round-trip with `claude` interactive TUI.
 *
 * Goal: prove that we can spawn `claude` in a PTY, type a message, and
 * capture the assistant's reply. No headless mode, no `-p`.
 *
 * Run: node pty-roundtrip.mjs "explain what 'pty' means in one line"
 *
 * Expected: process exits 0, prints the assistant reply to stdout, no
 * "credits used" message from claude CLI.
 */

import pty from "node-pty";
import stripAnsiMod from "strip-ansi";
import os from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const stripAnsi = stripAnsiMod.default ?? stripAnsiMod;

const prompt = process.argv.slice(2).join(" ") || "say 'hello' and nothing else";

function locateClaude() {
  if (process.env.CLAUDE_CLI && existsSync(process.env.CLAUDE_CLI)) return process.env.CLAUDE_CLI;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", os.platform() === "win32" ? "claude.exe" : "claude"),
    path.join(home, ".local", "bin", "claude"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const out = execSync(os.platform() === "win32" ? "where claude" : "which claude", {
      encoding: "utf8",
    });
    const first = out.split(/\r?\n/).find(Boolean);
    if (first && existsSync(first)) return first;
  } catch {}
  throw new Error("claude CLI not found. Set CLAUDE_CLI env var.");
}

const claudePath = locateClaude();
console.error(`[poc] claude: ${claudePath}`);
console.error(`[poc] prompt: ${prompt}`);
console.error(`[poc] spawning interactive TUI...`);

const cols = 120, rows = 40;
const env = { ...process.env };
delete env.CLAUDECODE; // 외부에서 이미 claude code 안이면 충돌 방지

const proc = pty.spawn(claudePath, [], {
  name: "xterm-256color",
  cols,
  rows,
  cwd: process.cwd(),
  env,
});

let allOutput = "";
const startedAt = Date.now();
let promptSent = false;
let promptSentAt = 0;
let lastDataAt = Date.now();
const IDLE_DONE_MS = 4000; // 4초간 출력 없으면 응답 끝났다고 본다
const HARD_TIMEOUT_MS = 90_000;

proc.onData((data) => {
  allOutput += data;
  lastDataAt = Date.now();
  process.stderr.write(".");
});

// TUI 부팅 잠시 기다린 후 프롬프트 주입
setTimeout(() => {
  console.error("\n[poc] injecting prompt");
  proc.write(prompt + "\r");
  promptSent = true;
  promptSentAt = Date.now();
}, 2000);

// idle-watchdog: 응답 종료 감지
const idleTimer = setInterval(() => {
  if (!promptSent) return;
  const idleMs = Date.now() - lastDataAt;
  if (idleMs >= IDLE_DONE_MS && Date.now() - promptSentAt > 5000) {
    console.error(`\n[poc] idle ${idleMs}ms — assuming response done, exiting`);
    finish(0);
  }
  if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
    console.error(`\n[poc] hard timeout (${HARD_TIMEOUT_MS}ms), exiting`);
    finish(1);
  }
}, 500);

function finish(code) {
  clearInterval(idleTimer);
  try { proc.kill(); } catch {}
  const clean = stripAnsi(allOutput);
  console.error(`\n[poc] raw bytes: ${allOutput.length}, clean chars: ${clean.length}`);
  console.error(`[poc] --- transcript (stripped) ---`);
  console.log(clean);
  console.error(`[poc] --- end transcript ---`);
  process.exit(code);
}

proc.onExit(({ exitCode }) => {
  console.error(`\n[poc] pty exited code=${exitCode}`);
  finish(exitCode ?? 0);
});
