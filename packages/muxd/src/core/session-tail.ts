/**
 * SessionTail — claude의 jsonl 세션 로그를 tail해서 응답을 정확히 캡처.
 *
 * 왜 TUI 화면 파싱 대신 파일 tail?
 *  - TUI는 짧은 응답을 collapse해서 화면에 표시 안 함 (확인된 버그/특성)
 *  - jsonl엔 모든 user/assistant/tool_use 메시지가 100% 누락 없이 기록
 *  - ANSI 노이즈 0, JSON 한 줄에 깔끔하게 포함
 *
 * 동작:
 *  1. spawn 직후 cwd에 해당하는 projects 디렉토리에서 가장 최근 생성/수정된
 *     jsonl을 찾아 우리 세션의 파일로 매핑 (PTY가 만들기 시작한 그 파일)
 *  2. fs.watch + 파일 크기 추적으로 새 라인 들어올 때마다 파싱
 *  3. type 별로 분류해 emit:
 *     - user / assistant / tool_use / tool_result
 *  4. assistant의 stop_reason !== null 이면 응답 완료 신호
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * cwd → claude projects 디렉토리 이름 인코딩.
 * claude CLI 규칙: 콜론/슬래시/백슬래시를 모두 `-`로 치환.
 *   "C:\\Git\\claude-mux"     → "C--Git-claude-mux"
 *   "/home/user/proj"         → "-home-user-proj"
 *   "C:/Git/foo"              → "C--Git-foo"
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-");
}

export function projectsDirFor(cwd: string): string {
  const home = process.env.CLAUDE_SESSION_HOME ?? os.homedir();
  return path.join(home, ".claude", "projects", encodeProjectDir(cwd));
}

export interface JsonlAssistantContentBlock {
  type: "text" | "tool_use" | string;
  text?: string;
  [k: string]: unknown;
}

export interface JsonlMessage {
  type?: string; // assistant / user / system / tool_use / tool_result ...
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: string | JsonlAssistantContentBlock[];
    stop_reason?: string | null;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface TailEvents {
  /** 새 jsonl 라인 발견 — 어떤 타입이든 */
  line: (msg: JsonlMessage, raw: string) => void;
  /** assistant 메시지 (응답 본문) */
  assistant: (text: string, msg: JsonlMessage) => void;
  /** assistant 메시지가 stop_reason 있어 "완료"로 판단됨 */
  done: (text: string, msg: JsonlMessage) => void;
  /** 도구 호출 발생 */
  toolUse: (block: JsonlAssistantContentBlock, msg: JsonlMessage) => void;
  /** tail 시작 (sessionId 매핑 성공) */
  attached: (filePath: string, sessionId: string) => void;
  /** 에러 (파일 못 찾음, 파싱 실패 등) */
  error: (err: Error) => void;
}

/** EventEmitter 타입 helper */
export declare interface SessionTail {
  on<E extends keyof TailEvents>(event: E, listener: TailEvents[E]): this;
  emit<E extends keyof TailEvents>(event: E, ...args: Parameters<TailEvents[E]>): boolean;
}

const ATTACH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 150;

export class SessionTail extends EventEmitter {
  readonly cwd: string;
  filePath: string | null = null;
  sessionId: string | null = null;

  private offset = 0;
  private buffer = "";
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  /** spawn 시점 기준으로 그 이후 생성된 파일만 우리 세션으로 인정 */
  private since: number;

  constructor(cwd: string, opts: { since?: number } = {}) {
    super();
    this.cwd = cwd;
    this.since = opts.since ?? Date.now() - 2_000;
  }

  /**
   * PTY spawn 직후 호출. since 이후 생성된 새 jsonl을 찾아 tail 시작.
   * Race condition: spawn 후 jsonl 생성까지 약간 지연 → 폴링으로 대기.
   */
  async attach(): Promise<void> {
    const dir = projectsDirFor(this.cwd);
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const startedAt = Date.now();

    while (!this.closed) {
      const file = await this.findFreshJsonl(dir);
      if (file) {
        this.filePath = file;
        this.sessionId = path.basename(file, ".jsonl");
        this.emit("attached", file, this.sessionId);
        this.startPolling();
        return;
      }
      if (Date.now() - startedAt > ATTACH_TIMEOUT_MS) {
        throw new Error(
          `SessionTail.attach timeout — no fresh jsonl in ${dir} after ${ATTACH_TIMEOUT_MS}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private async findFreshJsonl(dir: string): Promise<string | null> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const candidates: { name: string; mtime: number; birth: number }[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const full = path.join(dir, e.name);
      try {
        const st = await fsp.stat(full);
        candidates.push({
          name: full,
          mtime: st.mtimeMs,
          birth: st.birthtimeMs || st.ctimeMs,
        });
      } catch {}
    }
    if (candidates.length === 0) return null;
    // since 이후 새로 *생성된* 파일만 우리 세션으로 인정.
    // (mtime은 다른 세션의 기존 파일이 갱신돼도 변하므로 birthtime/ctime 우선)
    const fresh = candidates.filter((c) => c.birth >= this.since);
    if (fresh.length === 0) return null;
    fresh.sort((a, b) => b.birth - a.birth);
    return fresh[0].name;
  }

  private startPolling(): void {
    this.timer = setInterval(() => {
      this.drain().catch((err) => this.emit("error", err as Error));
    }, POLL_INTERVAL_MS);
  }

  private async drain(): Promise<void> {
    if (!this.filePath || this.closed) return;
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(this.filePath);
    } catch {
      return; // 아직 파일 없음
    }
    if (stat.size <= this.offset) return;
    const fh = await fsp.open(this.filePath, "r");
    try {
      const length = stat.size - this.offset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, this.offset);
      this.offset = stat.size;
      this.buffer += buf.toString("utf8");
      this.flushLines();
    } finally {
      await fh.close();
    }
  }

  private flushLines(): void {
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: JsonlMessage;
      try {
        obj = JSON.parse(trimmed) as JsonlMessage;
      } catch {
        continue;
      }
      this.emit("line", obj, trimmed);
      if (obj.type === "assistant" && obj.message) {
        const text = extractAssistantText(obj);
        const toolBlocks = extractToolUseBlocks(obj);
        for (const tb of toolBlocks) this.emit("toolUse", tb, obj);
        if (text) this.emit("assistant", text, obj);
        if (obj.message.stop_reason) this.emit("done", text, obj);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export function extractAssistantText(msg: JsonlMessage): string {
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

export function extractToolUseBlocks(
  msg: JsonlMessage,
): JsonlAssistantContentBlock[] {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is JsonlAssistantContentBlock => b?.type === "tool_use");
}
