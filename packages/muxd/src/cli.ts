#!/usr/bin/env node
/**
 * muxd CLI — 데몬 제어.
 * v0.0.1 스캐폴드: status / version만. start / stop은 후속 커밋.
 */

import { locateClaude, ClaudeCliNotFoundError } from "./core/locate-claude.js";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

function help(): void {
  console.log(`muxd — claude-mux daemon (v0.0.1 scaffold)

Usage:
  muxd status     데몬/claude CLI 상태 확인
  muxd version    버전 출력
  muxd help       이 도움말

(start / stop / serve는 후속 마일스톤에서 추가)
`);
}

function status(): void {
  try {
    const path = locateClaude();
    console.log(`claude CLI: ${path}`);
  } catch (e) {
    if (e instanceof ClaudeCliNotFoundError) {
      console.error(`claude CLI: NOT FOUND`);
      console.error(`  ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  console.log(`daemon: not running (scaffold — IPC not implemented yet)`);
}

switch (cmd) {
  case "status":
    status();
    break;
  case "version":
    console.log("0.0.1");
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
