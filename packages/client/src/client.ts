/**
 * @claude-mux/client — TS 클라이언트.
 *
 *   const c = new Client();   // 자동 connect (필요시 daemon spawn)
 *   const text = await c.ask(prompt, { cwd, mode: "automation" });
 *   const sess = await c.openSession({ cwd, mode: "automation" });
 *   await sess.send("...");
 *   await sess.close();
 *
 * 데몬 자동 spawn은 별도 모듈(auto-spawn.ts)에서 옵션으로 wiring.
 */

import { randomUUID } from "node:crypto";
import { RpcTransport } from "./transport.js";
import { defaultSocketPath } from "./socket-path.js";
import { isDaemonRunning, spawnDaemon } from "./auto-spawn.js";

export type SessionMode = "automation" | "chat" | "streaming";

export interface OpenSessionOpts {
  cwd: string;
  invoker?: string;
  mode?: SessionMode;
  allowedTools?: string;
  resumeId?: string;
  cols?: number;
  rows?: number;
}

export interface SendOpts {
  idleDeathMs?: number;
  maxMs?: number;
  /**
   * 응답에 자연어 거부 표현 매치 시 BlockedError throw. opt-in (false positive 위험).
   * 약속어(MUX_BLOCKED / <mux:blocked>)는 항상 검사하므로 별개.
   */
  detectFailure?: boolean;
}

export interface AskOpts extends OpenSessionOpts, SendOpts {}

export interface ClientOpts {
  /** 데몬 socket path 오버라이드 */
  socketPath?: string;
  /** 첫 호출 시 데몬 자동 spawn 시도 */
  autoSpawn?: boolean;
  /** 자동 spawn 시 muxd 바이너리 위치 */
  muxdPath?: string;
  /** 자동 spawn 후 daemon ready 대기 (ms) */
  spawnTimeoutMs?: number;
}

export class Client {
  private readonly transport: RpcTransport;
  private readonly socketPath: string;
  private readonly opts: Required<Pick<ClientOpts, "autoSpawn" | "spawnTimeoutMs">> &
    ClientOpts;
  private streamCallbacks = new Map<string, (chunk: string) => void>();
  private ensured = false;

  constructor(opts: ClientOpts = {}) {
    this.opts = {
      autoSpawn: opts.autoSpawn ?? true,
      spawnTimeoutMs: opts.spawnTimeoutMs ?? 5000,
      ...opts,
    };
    this.socketPath = opts.socketPath ?? defaultSocketPath();
    this.transport = new RpcTransport(this.socketPath);
    this.transport.onStreamChunk((streamId, chunk) => {
      const cb = this.streamCallbacks.get(streamId);
      cb?.(chunk);
    });
  }

  /** ensure daemon + connect — 모든 호출이 이걸 먼저 거침 */
  private async ensure(): Promise<void> {
    if (this.ensured) return;
    if (this.opts.autoSpawn) {
      const running = await isDaemonRunning(this.socketPath, 300);
      if (!running) {
        await spawnDaemon({
          socketPath: this.socketPath,
          muxdPath: this.opts.muxdPath,
          spawnTimeoutMs: this.opts.spawnTimeoutMs,
        });
      }
    }
    await this.transport.connect();
    this.ensured = true;
  }

  /** 명시 연결. ask/openSession이 자동 호출하므로 일반적으론 불필요. */
  async connect(timeoutMs?: number): Promise<void> {
    if (this.opts.autoSpawn) {
      const running = await isDaemonRunning(this.socketPath, 300);
      if (!running) {
        await spawnDaemon({
          socketPath: this.socketPath,
          muxdPath: this.opts.muxdPath,
          spawnTimeoutMs: this.opts.spawnTimeoutMs,
        });
      }
    }
    await this.transport.connect(timeoutMs);
    this.ensured = true;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** 단발 호출 — drop-in for `claude -p` */
  async ask(prompt: string, opts: AskOpts): Promise<string> {
    await this.ensure();
    const r = await this.transport.call<{ text: string }>("mux.ask", {
      prompt,
      cwd: opts.cwd,
      invoker: opts.invoker,
      mode: opts.mode ?? "automation",
      allowedTools: opts.allowedTools,
      resumeId: opts.resumeId,
      cols: opts.cols,
      rows: opts.rows,
      idleDeathMs: opts.idleDeathMs,
      maxMs: opts.maxMs,
      detectFailure: opts.detectFailure,
    });
    return r.text;
  }

  /** 재사용 가능한 세션 핸들 */
  async openSession(opts: OpenSessionOpts): Promise<Session> {
    await this.ensure();
    const r = await this.transport.call<{ sessionId: string }>(
      "mux.openSession",
      {
        cwd: opts.cwd,
        invoker: opts.invoker,
        mode: opts.mode ?? "automation",
        allowedTools: opts.allowedTools,
        resumeId: opts.resumeId,
        cols: opts.cols,
        rows: opts.rows,
      },
    );
    return new Session(this, r.sessionId);
  }

  /** Streaming — v0.1.2는 응답 단위 한 청크. 실제 토큰 streaming은 후속. */
  async stream(
    prompt: string,
    opts: AskOpts,
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    await this.ensure();
    // 일회용 streaming session
    const sess = await this.openSession(opts);
    try {
      const streamId = randomUUID();
      this.streamCallbacks.set(streamId, onChunk);
      try {
        const r = await this.transport.call<{ text: string }>("mux.stream", {
          sessionId: sess.id,
          prompt,
          streamId,
          idleDeathMs: opts.idleDeathMs,
          maxMs: opts.maxMs,
          detectFailure: opts.detectFailure,
        });
        return r.text;
      } finally {
        this.streamCallbacks.delete(streamId);
      }
    } finally {
      await sess.close().catch(() => {});
    }
  }

  /** 내부: Session.send에서 사용 */
  async _send(sessionId: string, prompt: string, opts: SendOpts): Promise<string> {
    await this.ensure();
    const r = await this.transport.call<{ text: string }>("mux.send", {
      sessionId,
      prompt,
      idleDeathMs: opts.idleDeathMs,
      maxMs: opts.maxMs,
      detectFailure: opts.detectFailure,
    });
    return r.text;
  }

  /** 내부: Session.close에서 사용 */
  async _close(sessionId: string): Promise<void> {
    await this.ensure();
    await this.transport.call("mux.close", { sessionId });
  }

  /** 데몬 상태 */
  async status(): Promise<{
    pid: number;
    uptimeMs: number;
    sessions: number;
    version: string;
  }> {
    await this.ensure();
    return this.transport.call("mux.status", {});
  }
}

export class Session {
  constructor(
    private readonly client: Client,
    public readonly id: string,
  ) {}

  async send(prompt: string, opts: SendOpts = {}): Promise<string> {
    return this.client._send(this.id, prompt, opts);
  }

  async close(): Promise<void> {
    await this.client._close(this.id);
  }
}
