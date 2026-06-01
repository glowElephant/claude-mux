/**
 * muxd daemon server.
 *
 * - net.createServer로 Unix socket / Named pipe listen
 * - JSON-RPC 2.0 over NDJSON
 * - sessionId → PtySession 레지스트리
 * - 메서드: openSession / send / stream / close / ask / status / shutdown
 *
 * v0.1.2 범위: 단일 호스트 / 단일 사용자. 멀티 사용자 권한, TLS, 인증 없음 —
 * Unix socket / Named pipe 권한이 OS 사용자에 묶여있으니 그걸로 충분.
 */

import net, { type Socket, type Server } from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { PtySession } from "../core/pty-session.js";
import { BlockedError } from "../core/errors.js";
import type { OpenSessionOpts } from "../core/types.js";
import { daemonSocketPath } from "./socket-path.js";
import { attachNdjsonReader, writeMessage } from "./framing.js";
import {
  type AskParams,
  type AskResult,
  type CloseParams,
  type CloseResult,
  type JsonRpcErrorResponse,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type OpenSessionParams,
  type OpenSessionResult,
  type SendParams,
  type SendResult,
  type ShutdownResult,
  type StatusResult,
  type StreamChunkNotification,
  type StreamParams,
  type StreamResult,
  JsonRpcErrorCode,
  muxCodeToJsonRpc,
} from "./protocol.js";
import type { MuxBaseError } from "../core/errors.js";

const VERSION = "0.1.7";

interface ServerOpts {
  /** override socket path (테스트용) */
  socketPath?: string;
  /** 데몬 시작 시각 — uptime 계산 */
  startedAt?: number;
  /**
   * 디버그 모드 — 각 세션의 PTY 출력을 ring buffer에 저장 + subscriber에 broadcast.
   * `MUXD_DEBUG=1` 환경변수로도 활성화 (CLI가 처리).
   */
  debug?: boolean;
  /** ring buffer 라인 수 (기본 500). 디버그 모드에서만 의미 있음. */
  debugRingLines?: number;
}

/** 한 세션의 디버그 상태 — PTY 출력 ring + subscribers. */
interface SessionDebugState {
  /** 세션 정보 스냅샷 */
  info: {
    sessionId: string;
    invoker: string;
    cwd: string;
    mode: string;
    createdAt: number;
  };
  /** 종료된 세션 여부 */
  closed: boolean;
  /** PTY chunk ring buffer — 라인 단위로 잘라서 보관. 최신이 뒤. */
  ring: string[];
  /** 활성 subscriber socket들. close 시 정리. */
  subscribers: Set<Socket>;
}

export class DaemonServer {
  private server: Server | null = null;
  private readonly sessions = new Map<string, PtySession>();
  private readonly socketPath: string;
  private readonly startedAt: number;
  /** 클라이언트 연결당 stream id → sock 매핑 — 종료 시 정리 */
  private readonly streamingConns = new Set<Socket>();

  private readonly debug: boolean;
  private readonly debugRingLines: number;
  /** 디버그용 — 활성/종료된 세션의 PTY 출력 ring + subscriber */
  private readonly debugStates = new Map<string, SessionDebugState>();

  constructor(opts: ServerOpts = {}) {
    this.socketPath = opts.socketPath ?? daemonSocketPath();
    this.startedAt = opts.startedAt ?? Date.now();
    this.debug = opts.debug ?? (process.env.MUXD_DEBUG === "1");
    this.debugRingLines = opts.debugRingLines ?? 500;
  }

  get debugEnabled(): boolean {
    return this.debug;
  }

  async listen(): Promise<string> {
    // POSIX: 기존 stale socket 파일 제거
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // 없으면 무시
      }
    }
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this.onConnection(sock));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => {
        resolve(this.socketPath);
      });
    });
  }

  /** 모든 세션 close + 서버 close */
  async stop(): Promise<void> {
    const closes = Array.from(this.sessions.values()).map((s) =>
      s.close().catch(() => {}),
    );
    await Promise.all(closes);
    this.sessions.clear();
    for (const sock of this.streamingConns) sock.destroy();
    this.streamingConns.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {}
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  private onConnection(sock: Socket): void {
    const reader = attachNdjsonReader(sock);
    this.streamingConns.add(sock);
    sock.on("close", () => this.streamingConns.delete(sock));
    reader.on("message", (msg) => {
      void this.handleMessage(sock, msg);
    });
    reader.on("error", (err) => {
      // 한 줄 파싱 실패 — 연결은 유지 (다음 줄 시도)
      writeMessage(sock, this.errorResp(null, JsonRpcErrorCode.ParseError, err.message));
    });
  }

  private async handleMessage(sock: Socket, msg: JsonRpcMessage): Promise<void> {
    if (!("method" in msg) || !("id" in msg)) {
      // notification은 처리 안 함 (현재는 server → client만)
      return;
    }
    const req = msg as JsonRpcRequest;
    try {
      const result = await this.dispatch(sock, req);
      const resp: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: req.id,
        result,
      };
      writeMessage(sock, resp);
    } catch (err) {
      const e = err as MuxBaseError | Error;
      const code =
        "code" in e && typeof (e as MuxBaseError).code === "string"
          ? muxCodeToJsonRpc((e as MuxBaseError).code)
          : JsonRpcErrorCode.InternalError;
      const data =
        e instanceof BlockedError
          ? { reason: e.reason, sessionId: e.sessionId, rawReply: e.rawReply }
          : undefined;
      writeMessage(sock, this.errorResp(req.id, code, e.message, data));
    }
  }

  private errorResp(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcErrorResponse {
    return { jsonrpc: "2.0", id, error: { code, message, data } };
  }

  private async dispatch(sock: Socket, req: JsonRpcRequest): Promise<unknown> {
    switch (req.method) {
      case "mux.openSession":
        return this.openSession(req.params as OpenSessionParams);
      case "mux.send":
        return this.send(req.params as SendParams);
      case "mux.stream":
        return this.stream(sock, req.params as StreamParams);
      case "mux.close":
        return this.close(req.params as CloseParams);
      case "mux.ask":
        return this.ask(req.params as AskParams);
      case "mux.status":
        return this.status();
      case "mux.shutdown":
        return this.shutdown();
      case "mux.debugList":
        return this.debugList();
      case "mux.debugSubscribe":
        return this.debugSubscribe(sock, req.params as { sessionId: string });
      default:
        throw new MethodNotFoundError(req.method);
    }
  }

  /** 디버그 모드일 때 새 세션마다 ring + subscriber 컨테이너 생성 + PTY data hook. */
  private attachDebug(s: PtySession): void {
    if (!this.debug) return;
    const state: SessionDebugState = {
      info: {
        sessionId: s.id,
        invoker: s.invoker,
        cwd: s.cwd,
        mode: s.mode,
        createdAt: s.createdAt,
      },
      closed: false,
      ring: [],
      subscribers: new Set<Socket>(),
    };
    this.debugStates.set(s.id, state);
    let pending = "";
    s.on("data", (chunk: string) => {
      pending += chunk;
      // ring은 라인 단위로 — 라인 partial은 다음 chunk와 합침
      const idx = pending.lastIndexOf("\n");
      if (idx < 0) return;
      const complete = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      const lines = complete.split(/\r?\n/);
      for (const line of lines) {
        state.ring.push(line);
        if (state.ring.length > this.debugRingLines) state.ring.shift();
      }
      // subscriber에 broadcast
      const noti = JSON.stringify({
        jsonrpc: "2.0",
        method: "mux.debugChunk",
        params: { sessionId: s.id, chunk: complete + "\n" },
      }) + "\n";
      for (const sub of state.subscribers) {
        try {
          sub.write(noti);
        } catch {
          // 끊긴 subscriber — close 이벤트로 정리됨
        }
      }
    });
    s.on("exit", () => {
      state.closed = true;
      // subscriber에 close notification
      const noti = JSON.stringify({
        jsonrpc: "2.0",
        method: "mux.debugClose",
        params: { sessionId: s.id },
      }) + "\n";
      for (const sub of state.subscribers) {
        try {
          sub.write(noti);
        } catch {}
      }
    });
  }

  private debugList(): {
    debug: boolean;
    sessions: Array<{
      sessionId: string;
      invoker: string;
      cwd: string;
      mode: string;
      createdAt: number;
      closed: boolean;
      ringLines: number;
    }>;
  } {
    if (!this.debug) return { debug: false, sessions: [] };
    const out = Array.from(this.debugStates.values()).map((s) => ({
      ...s.info,
      closed: s.closed,
      ringLines: s.ring.length,
    }));
    return { debug: true, sessions: out };
  }

  private debugSubscribe(
    sock: Socket,
    p: { sessionId: string },
  ): { ok: boolean; ring: string[]; closed: boolean } {
    if (!this.debug) {
      throw new Error("debug mode not enabled (set MUXD_DEBUG=1)");
    }
    const state = this.debugStates.get(p.sessionId);
    if (!state) throw new SessionNotFoundError(p.sessionId);
    state.subscribers.add(sock);
    sock.on("close", () => state.subscribers.delete(sock));
    return { ok: true, ring: [...state.ring], closed: state.closed };
  }

  private async openSession(p: OpenSessionParams): Promise<OpenSessionResult> {
    const opts: OpenSessionOpts = {
      cwd: p.cwd,
      invoker: p.invoker,
      mode: p.mode,
      allowedTools: p.allowedTools,
      resumeId: p.resumeId,
      cols: p.cols,
      rows: p.rows,
    };
    const s = new PtySession(opts);
    this.attachDebug(s);
    await s.init({});
    this.sessions.set(s.id, s);
    s.on("exit", () => this.sessions.delete(s.id));
    return { sessionId: s.id };
  }

  private async send(p: SendParams): Promise<SendResult> {
    const s = this.sessions.get(p.sessionId);
    if (!s) throw new SessionNotFoundError(p.sessionId);
    const text = await s.send(p.prompt, {
      idleDeathMs: p.idleDeathMs,
      maxMs: p.maxMs,
      detectFailure: p.detectFailure,
    });
    return { text };
  }

  private async stream(sock: Socket, p: StreamParams): Promise<StreamResult> {
    const s = this.sessions.get(p.sessionId);
    if (!s) throw new SessionNotFoundError(p.sessionId);
    // v0.1.2: 응답이 끝나면 한 청크로 push (claude jsonl이 응답 단위라).
    // 진짜 토큰 스트리밍은 후속. 일단 send 결과를 한 번에 chunk로 보내고 result로도 반환.
    const text = await s.send(p.prompt, {
      idleDeathMs: p.idleDeathMs,
      maxMs: p.maxMs,
      detectFailure: p.detectFailure,
    });
    const noti: { jsonrpc: "2.0"; method: string; params: StreamChunkNotification } = {
      jsonrpc: "2.0",
      method: "mux.streamChunk",
      params: { streamId: p.streamId, chunk: text },
    };
    writeMessage(sock, noti);
    return { text };
  }

  private async close(p: CloseParams): Promise<CloseResult> {
    const s = this.sessions.get(p.sessionId);
    if (!s) return { ok: true }; // idempotent
    await s.close();
    this.sessions.delete(p.sessionId);
    return { ok: true };
  }

  private async ask(p: AskParams): Promise<AskResult> {
    const sessionId = randomUUID();
    const s = new PtySession({
      cwd: p.cwd,
      invoker: p.invoker,
      mode: p.mode ?? "automation",
      allowedTools: p.allowedTools,
      cols: p.cols,
      rows: p.rows,
    });
    this.attachDebug(s);
    try {
      await s.init({});
      const text = await s.send(p.prompt, {
        idleDeathMs: p.idleDeathMs,
        maxMs: p.maxMs,
      });
      return { text };
    } finally {
      await s.close().catch(() => {});
    }
    // sessionId는 ask 내부 일회용 — 외부 공개 안 함
    void sessionId;
  }

  private status(): StatusResult {
    return {
      pid: process.pid,
      uptimeMs: Date.now() - this.startedAt,
      sessions: this.sessions.size,
      version: VERSION,
    };
  }

  private async shutdown(): Promise<ShutdownResult> {
    // 호출자에 응답 보내고 약간의 지연 후 stop
    setImmediate(() => {
      this.stop().catch(() => {});
    });
    return { ok: true };
  }
}

class MethodNotFoundError extends Error {
  readonly code = "METHOD_NOT_FOUND";
  constructor(method: string) {
    super(`method not found: ${method}`);
  }
}

class SessionNotFoundError extends Error {
  readonly code = "SESSION_NOT_FOUND";
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}
