/**
 * PtySession — claude TUI 1개를 PTY로 감싸고 메시지 큐로 제어.
 *
 * 책임:
 *  - PTY spawn + TUI ready 감지
 *  - 첫 메시지로 system prompt 주입 + MUX_READY 핸드셰이크 (실패 fallback)
 *  - 메시지 큐 (동시 send 직렬화)
 *  - 응답 완료 감지 (idle AND ❯ 마커, 둘 다 만족)
 *  - 타임아웃 → Esc 인터럽트 → Ctrl+C fallback
 *  - exit/사망 감지 + 자동 정리
 *
 * 알려진 한계 (TODO):
 *  - 응답 본문에 ❯ 가 포함되면 idle만으로 fallback
 *  - claude CLI 버전 변경 시 TUI 출력 패턴 깨질 수 있음 (parser에 위임)
 *  - resume(--resume) 지원은 후속 커밋
 */

import pty from "node-pty";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { locateClaude } from "./locate-claude.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { encodeForPty, INTERRUPT_ESC, INTERRUPT_CTRL_C } from "./input-encoder.js";
import {
  extractAssistantText,
  parseFrame,
  type UsageSnapshot,
} from "./tui-parser.js";
import type { OpenSessionOpts, SessionInfo, SessionMode } from "./types.js";

interface QueueItem {
  prompt: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  /** 활동 기반: N ms간 PTY 출력 없으면 죽었다고 판단. 0이면 디폴트. */
  idleDeathMs: number;
  /** 절대 상한 (옵션, 0이면 무제한 — 활동 있는 한 계속). */
  maxMs: number;
}

export interface SendOpts {
  /** 활동 기반 죽음 판정: 마지막 PTY 청크 이후 idle (ms). 기본 60_000 */
  idleDeathMs?: number;
  /** 절대 상한 (ms). 0/미지정이면 무제한 (활동만 보면 됨) */
  maxMs?: number;
}

export interface PtySessionEvents {
  data: (chunk: string) => void;
  exit: (code: number | null) => void;
  error: (err: Error) => void;
  usage: (u: UsageSnapshot) => void;
}

/** 응답 완료 판단 idle (ms) — ❯ 마커와 AND 조건 */
const IDLE_DONE_MS = 1500;
/** ❯ 마커가 안 떠도 fallback으로 완료 처리할 idle (ms) */
const IDLE_FALLBACK_MS = 8_000;
/** 활동 없는 채로 이 시간 지나면 죽었다고 판정 (기본값) */
const DEFAULT_IDLE_DEATH_MS = 60_000;
/** TUI 부팅 ready 감지 타임아웃 */
const READY_TIMEOUT_MS = 20_000;
/** MUX_READY 핸드셰이크 응답 대기 (실패해도 그냥 통과) */
const HANDSHAKE_TIMEOUT_MS = 45_000;

export class PtySession extends EventEmitter {
  readonly id: string;
  readonly mode: SessionMode;
  readonly invoker: string;
  readonly cwd: string;
  readonly createdAt: number;
  lastUsedAt: number;

  private proc: pty.IPty;
  private buffer = ""; // 응답 진행 중 누적
  private allOutput = ""; // 디버그 / 사용량 파싱용 전체
  private lastDataAt = Date.now();
  private queue: QueueItem[] = [];
  private busy = false;
  private dead = false;
  private currentTimer: NodeJS.Timeout | null = null;
  private currentResponseStartIdx = 0;

  constructor(opts: OpenSessionOpts) {
    super();
    this.id = randomUUID();
    this.mode = opts.mode ?? "automation";
    this.invoker = opts.invoker ?? "unknown";
    this.cwd = opts.cwd;
    this.createdAt = Date.now();
    this.lastUsedAt = this.createdAt;

    const claudePath = locateClaude();
    const env = { ...process.env };
    delete env.CLAUDECODE; // 외부 claude code 안에서 spawn 시 충돌 방지

    const spawnArgs: string[] = [];
    if (opts.resumeId) {
      spawnArgs.push("--resume", opts.resumeId);
    }

    this.proc = pty.spawn(claudePath, spawnArgs, {
      name: "xterm-256color",
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      cwd: opts.cwd,
      env,
    });

    this.proc.onData((d) => this.onPtyData(d));
    this.proc.onExit(({ exitCode }) => {
      this.dead = true;
      this.emit("exit", exitCode ?? null);
      // 대기 중인 큐 모두 실패 처리
      while (this.queue.length) {
        const item = this.queue.shift()!;
        item.reject(new SessionDeadError(this.id));
      }
    });
  }

  /** TUI ready 감지 (`❯` 마커 첫 출현) → system prompt 주입 + 핸드셰이크. */
  async init(opts: { allowedTools?: string }): Promise<void> {
    await this.waitForReady();
    // 부팅 출력은 응답 분석에서 제외
    this.allOutput = this.buffer;
    this.buffer = "";
    this.currentResponseStartIdx = 0;

    const systemPrompt = buildSystemPrompt({
      mode: this.mode,
      invoker: this.invoker,
      allowedTools: opts.allowedTools,
    });

    // 핸드셰이크: MUX_READY 응답 기대하되 실패해도 통과
    // 'error' 이벤트는 listener 없으면 throw하므로 'warn' 사용 (구독 옵션)
    try {
      const ack = await this.sendInternal(systemPrompt, {
        idleDeathMs: HANDSHAKE_TIMEOUT_MS,
        maxMs: HANDSHAKE_TIMEOUT_MS,
      });
      if (!/MUX_READY/.test(ack)) {
        this.emitWarning(new HandshakeWarning(this.id, ack));
      }
    } catch (err) {
      this.emitWarning(new HandshakeWarning(this.id, String(err)));
    }
  }

  /** 'error' 대신 'warn' 채널로 — listener 없어도 throw 안 함 */
  private emitWarning(err: Error): void {
    if (this.listenerCount("warn") > 0) this.emit("warn", err);
  }

  /** 외부 send. 큐에 넣고 직렬 처리. 활동 기반 idle 죽음 + 옵션 절대 상한. */
  send(prompt: string, opts: SendOpts = {}): Promise<string> {
    if (this.dead) return Promise.reject(new SessionDeadError(this.id));
    return new Promise((resolve, reject) => {
      this.queue.push({
        prompt,
        resolve,
        reject,
        idleDeathMs: opts.idleDeathMs ?? DEFAULT_IDLE_DEATH_MS,
        maxMs: opts.maxMs ?? 0,
      });
      this.drain();
    });
  }

  info(): SessionInfo {
    return {
      id: this.id,
      pid: this.proc.pid,
      mode: this.mode,
      invoker: this.invoker,
      cwd: this.cwd,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      queueDepth: this.queue.length,
      busy: this.busy,
    };
  }

  async close(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
  }

  // === internal ===

  private onPtyData(chunk: string): void {
    this.buffer += chunk;
    this.allOutput += chunk;
    this.lastDataAt = Date.now();
    this.emit("data", chunk);

    // 사용량 카운터 변화 감지
    const frame = parseFrame(this.allOutput);
    if (frame.usage) this.emit("usage", frame.usage);
  }

  private async waitForReady(): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        const f = parseFrame(this.buffer);
        if (f.promptReady) {
          clearInterval(iv);
          resolve();
          return;
        }
        if (this.dead) {
          clearInterval(iv);
          reject(new SessionDeadError(this.id));
          return;
        }
        if (Date.now() - start > READY_TIMEOUT_MS) {
          clearInterval(iv);
          reject(
            new Error(
              `TUI ready timeout (${READY_TIMEOUT_MS}ms). Is claude CLI working?`,
            ),
          );
        }
      }, 200);
    });
  }

  private async drain(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    const item = this.queue.shift()!;
    try {
      const text = await this.sendInternal(item.prompt, {
        idleDeathMs: item.idleDeathMs,
        maxMs: item.maxMs,
      });
      item.resolve(text);
    } catch (err) {
      item.reject(err as Error);
    } finally {
      this.busy = false;
      this.lastUsedAt = Date.now();
      // 다음 항목
      setImmediate(() => this.drain());
    }
  }

  private sendInternal(prompt: string, opts: Required<SendOpts>): Promise<string> {
    return new Promise((resolve, reject) => {
      this.currentResponseStartIdx = this.allOutput.length;
      this.buffer = "";
      this.lastDataAt = Date.now();
      const sentAt = Date.now();

      // 멀티라인 안전 처리 → CR로 submit
      const encoded = encodeForPty(prompt, { multiline: "flatten" });
      this.proc.write(encoded);

      const finish = (err?: Error): void => {
        if (this.currentTimer) {
          clearInterval(this.currentTimer);
          this.currentTimer = null;
        }
        if (err) return reject(err);
        const slice = this.allOutput.slice(this.currentResponseStartIdx);
        resolve(extractAssistantText(slice));
      };

      this.currentTimer = setInterval(() => {
        if (this.dead) {
          finish(new SessionDeadError(this.id));
          return;
        }
        const now = Date.now();
        const idleMs = now - this.lastDataAt;
        const elapsedMs = now - sentAt;
        const frame = parseFrame(this.buffer);

        // 핵심 완료 조건: idle 짧음 AND 프롬프트 마커 재출현
        if (idleMs >= IDLE_DONE_MS && frame.promptReady && elapsedMs > 800) {
          finish();
          return;
        }
        // fallback: 마커 없어도 idle 길면 완료
        if (idleMs >= IDLE_FALLBACK_MS && elapsedMs > 800) {
          finish();
          return;
        }
        // 활동 기반 죽음 판정 (사용자 제어 가능)
        if (idleMs >= opts.idleDeathMs) {
          this.interrupt();
          finish(new IdleDeathError(this.id, opts.idleDeathMs));
          return;
        }
        // 절대 상한 (옵션 — 0이면 무제한)
        if (opts.maxMs > 0 && elapsedMs >= opts.maxMs) {
          this.interrupt();
          finish(new MaxDurationError(this.id, opts.maxMs));
          return;
        }
      }, 200);
    });
  }

  private interrupt(): void {
    try {
      this.proc.write(INTERRUPT_ESC);
      setTimeout(() => {
        if (!this.dead) {
          try {
            this.proc.write(INTERRUPT_CTRL_C);
          } catch {}
        }
      }, 500);
    } catch {}
  }
}

// === errors ===

export class SessionDeadError extends Error {
  code = "SESSION_DEAD" as const;
  constructor(public sessionId: string) {
    super(`Session ${sessionId} is dead`);
  }
}

export class IdleDeathError extends Error {
  code = "IDLE_DEATH" as const;
  constructor(
    public sessionId: string,
    public idleMs: number,
  ) {
    super(
      `Session ${sessionId}: no PTY output for ${idleMs}ms — assumed dead/stuck`,
    );
  }
}

export class MaxDurationError extends Error {
  code = "MAX_DURATION" as const;
  constructor(
    public sessionId: string,
    public maxMs: number,
  ) {
    super(`Session ${sessionId} exceeded max duration ${maxMs}ms`);
  }
}

/** 핸드셰이크가 기대 형식대로 안 왔을 때 — fatal 아님, 경고용. */
export class HandshakeWarning extends Error {
  code = "HANDSHAKE_WARN" as const;
  constructor(
    public sessionId: string,
    public reply: string,
  ) {
    super(
      `Session ${sessionId}: MUX_READY handshake not echoed. Reply: ${reply.slice(0, 200)}`,
    );
  }
}
