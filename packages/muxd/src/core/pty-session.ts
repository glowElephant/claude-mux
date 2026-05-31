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
import { parseFrame, type UsageSnapshot } from "./tui-parser.js";
import { SessionTail, type JsonlMessage } from "./session-tail.js";
import { BlockedError, matchBlocked } from "./errors.js";
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
  private buffer = ""; // TUI 활동/사용량 추적용 (응답 본문은 jsonl tail에서 가져옴)
  private allOutput = "";
  private lastDataAt = Date.now();
  private queue: QueueItem[] = [];
  private busy = false;
  private dead = false;
  private currentTimer: NodeJS.Timeout | null = null;
  private tail: SessionTail;
  /** 현재 대기 중인 응답 — jsonl에서 done 이벤트 오면 resolve */
  private pendingResolve: ((text: string) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private pendingText = ""; // assistant chunk 누적 (여러 text 블록 가능)

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

    // jsonl tail은 PTY spawn 시각 이후 생긴 파일만 우리 세션으로 인정
    this.tail = new SessionTail(opts.cwd, { since: this.createdAt - 1_000 });
    this.tail.on("assistant", (text) => {
      this.pendingText += text;
    });
    this.tail.on("done", (text) => {
      // text 인자는 마지막 메시지 본문, pendingText는 누적
      const finalText = this.pendingText || text;
      this.pendingText = "";
      if (this.pendingResolve) {
        const r = this.pendingResolve;
        const j = this.pendingReject;
        this.pendingResolve = null;
        this.pendingReject = null;
        // 약속어 매치 → reject. 호출자 try/catch로 실패 분기 가능.
        const reason = matchBlocked(finalText);
        if (reason !== null) {
          j?.(new BlockedError(this.id, reason, finalText));
          return;
        }
        r(finalText);
      }
    });
    this.tail.on("error", (err) => this.emitWarning(err));

    this.proc.onData((d) => this.onPtyData(d));
    this.proc.onExit(({ exitCode }) => {
      this.dead = true;
      this.emit("exit", exitCode ?? null);
      this.tail.close().catch(() => {});
      while (this.queue.length) {
        const item = this.queue.shift()!;
        item.reject(new SessionDeadError(this.id));
      }
      if (this.pendingReject) {
        this.pendingReject(new SessionDeadError(this.id));
        this.pendingResolve = null;
        this.pendingReject = null;
      }
    });
  }

  /**
   * 초기화 — TUI ready + system prompt 핸드셰이크 (병렬 attach).
   *
   * 주의: claude는 PTY spawn만으로 jsonl 파일을 만들지 않는다 — 첫 입력이
   * 도착해야 파일이 생성됨. 그래서 attach는 system prompt 송신과 병렬로
   * 진행해야 한다.
   */
  async init(opts: { allowedTools?: string }): Promise<void> {
    await this.waitForReady();
    this.allOutput = this.buffer;
    this.buffer = "";

    // attach를 background로 — 첫 send가 jsonl을 생성시킴
    const attachPromise = this.tail.attach().catch((err) => {
      this.emitWarning(err as Error);
    });

    const systemPrompt = buildSystemPrompt({
      mode: this.mode,
      invoker: this.invoker,
      allowedTools: opts.allowedTools,
    });

    // 핸드셰이크: MUX_READY 응답 기대하되 실패해도 통과.
    // sendInternal이 PTY write를 즉시 수행 → claude가 jsonl 파일 만들기 시작 →
    // attach가 완료 → done 이벤트 → sendInternal resolve. 순서 자연스럽게 풀림.
    try {
      const ack = await this.sendInternal(systemPrompt, {
        idleDeathMs: HANDSHAKE_TIMEOUT_MS,
        maxMs: HANDSHAKE_TIMEOUT_MS,
      });
      await attachPromise; // attach 결과 확정 (warn은 위에서 emit됨)
      if (!/MUX_READY/.test(ack)) {
        this.emitWarning(new HandshakeWarning(this.id, ack));
      }
    } catch (err) {
      await attachPromise;
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
    const exitPromise = new Promise<void>((resolve) => {
      const onExit = (): void => resolve();
      // exit 이벤트가 이미 트리거됐을 수 있으니 1초 안에 안 오면 강제 진행
      this.proc.onExit(onExit);
      setTimeout(onExit, 1500);
    });
    this.dead = true;
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
    await exitPromise;
    await this.tail.close().catch(() => {});
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

  /**
   * 메시지 1개 전송 → jsonl `done` 이벤트 대기 → 응답 텍스트 반환.
   *
   * 응답 끝 판정: jsonl에서 stop_reason !== null인 assistant 메시지 도착.
   * TUI 출력은 보조용 (활동성 확인, idle 죽음 판정).
   */
  private sendInternal(prompt: string, opts: Required<SendOpts>): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pendingText = "";
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.buffer = "";
      this.lastDataAt = Date.now();
      const sentAt = Date.now();

      const encoded = encodeForPty(prompt, { multiline: "flatten" });
      this.proc.write(encoded);

      const cleanup = (): void => {
        if (this.currentTimer) {
          clearInterval(this.currentTimer);
          this.currentTimer = null;
        }
      };

      // pendingResolve/Reject가 done 이벤트나 사망 이벤트로 호출되면 cleanup 보장
      const origResolve = this.pendingResolve;
      const origReject = this.pendingReject;
      this.pendingResolve = (text) => {
        cleanup();
        origResolve!(text);
      };
      this.pendingReject = (err) => {
        cleanup();
        origReject!(err);
      };

      // watchdog: jsonl이 안 와도 PTY 활동이 멈추면 죽었다고 판단
      this.currentTimer = setInterval(() => {
        if (this.dead) {
          if (this.pendingReject) {
            const r = this.pendingReject;
            this.pendingResolve = null;
            this.pendingReject = null;
            r(new SessionDeadError(this.id));
          }
          return;
        }
        const now = Date.now();
        const idleMs = now - this.lastDataAt;
        const elapsedMs = now - sentAt;

        if (idleMs >= opts.idleDeathMs) {
          this.interrupt();
          if (this.pendingReject) {
            const r = this.pendingReject;
            this.pendingResolve = null;
            this.pendingReject = null;
            r(new IdleDeathError(this.id, opts.idleDeathMs));
          }
          return;
        }
        if (opts.maxMs > 0 && elapsedMs >= opts.maxMs) {
          this.interrupt();
          if (this.pendingReject) {
            const r = this.pendingReject;
            this.pendingResolve = null;
            this.pendingReject = null;
            r(new MaxDurationError(this.id, opts.maxMs));
          }
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
