#!/usr/bin/env node
/**
 * 직렬 큐 버그 진단 — raw PTY 출력을 그대로 파일에 덤프해서 어디서
 * 응답이 묻히는지 확인한다.
 *
 * Usage: node debug-serial.mjs
 * Output: debug-serial.log (raw bytes, ANSI 포함)
 */

import pty from "node-pty";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { existsSync } from "node:fs";

function locateClaude() {
  if (process.env.CLAUDE_CLI && existsSync(process.env.CLAUDE_CLI))
    return process.env.CLAUDE_CLI;
  const cand = path.join(
    os.homedir(),
    ".local",
    "bin",
    os.platform() === "win32" ? "claude.exe" : "claude",
  );
  if (existsSync(cand)) return cand;
  throw new Error("claude not found");
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

const log = fs.createWriteStream("debug-serial.log");
let totalBytes = 0;
proc.onData((d) => {
  totalBytes += d.length;
  log.write(d);
  // stderr에 진행 상황만 (raw 출력은 파일로)
  process.stderr.write(`[+${d.length}b]`);
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  await sleep(3000); // TUI 부팅
  process.stderr.write("\n[bootDone]\n");

  // 메시지 1
  process.stderr.write("\n--- msg 1 ---\n");
  proc.write('reply with exactly "ONE" and nothing else\r');
  await sleep(15000);

  // 메시지 2
  process.stderr.write("\n--- msg 2 ---\n");
  proc.write('reply with exactly "TWO" and nothing else\r');
  await sleep(15000);

  // 메시지 3
  process.stderr.write("\n--- msg 3 ---\n");
  proc.write('reply with exactly "THREE" and nothing else\r');
  await sleep(15000);

  process.stderr.write(`\n[done] totalBytes=${totalBytes}\n`);
  proc.kill();
  log.end();
  setTimeout(() => process.exit(0), 500);
}
main();
