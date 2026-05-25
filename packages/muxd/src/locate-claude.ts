/**
 * claude CLI 실행 파일 위치 탐색.
 * 우선순위:
 *  1. CLAUDE_CLI 환경 변수
 *  2. ~/.local/bin/claude(.exe) (Anthropic 공식 인스톨러 기본 위치)
 *  3. which / where 명령
 */

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export class ClaudeCliNotFoundError extends Error {
  code = "CLAUDE_NOT_FOUND" as const;
  constructor() {
    super(
      "claude CLI not found. Install Claude Code or set CLAUDE_CLI env var. " +
        "See https://docs.anthropic.com/en/docs/claude-code",
    );
  }
}

let cached: string | null = null;

export function locateClaude(): string {
  if (cached) return cached;

  const envPath = process.env.CLAUDE_CLI;
  if (envPath && existsSync(envPath)) {
    cached = envPath;
    return cached;
  }

  const home = os.homedir();
  const isWin = os.platform() === "win32";
  const exe = isWin ? "claude.exe" : "claude";
  const direct = path.join(home, ".local", "bin", exe);
  if (existsSync(direct)) {
    cached = direct;
    return cached;
  }

  try {
    const cmd = isWin ? "where claude" : "which claude";
    const out = execSync(cmd, { encoding: "utf8" });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && existsSync(first)) {
      cached = first;
      return cached;
    }
  } catch {
    // fall through
  }

  throw new ClaudeCliNotFoundError();
}
