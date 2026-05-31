/**
 * JSON-RPC client transport over Unix socket / Named pipe.
 *
 * - net.connect로 연결
 * - request id 자동 발급, response 매칭
 * - stream notification (mux.streamChunk) 별도 콜백
 * - 연결 단절 시 모든 pending request reject
 */

import net, { type Socket } from "node:net";
import { MuxClientError, buildErrorFromRpc, type ClientErrorCode } from "./errors.js";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (err: Error) => void;
};

export type StreamChunkHandler = (streamId: string, chunk: string) => void;

export class RpcTransport {
  private sock: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private streamHandler: StreamChunkHandler | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly socketPath: string) {}

  onStreamChunk(handler: StreamChunkHandler): void {
    this.streamHandler = handler;
  }

  async connect(timeoutMs = 5000): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      this.sock = sock;
      sock.setEncoding("utf8");
      const timer = setTimeout(() => {
        sock.destroy();
        this.connectPromise = null;
        reject(
          new MuxClientError(
            "CONNECT_FAILED" as ClientErrorCode,
            `connect timeout (${timeoutMs}ms) ${this.socketPath}`,
          ),
        );
      }, timeoutMs);
      sock.on("connect", () => {
        clearTimeout(timer);
        this.connected = true;
        resolve();
      });
      sock.on("data", (chunk: string) => this.onData(chunk));
      sock.on("error", (err) => {
        if (!this.connected) {
          clearTimeout(timer);
          this.connectPromise = null;
          reject(
            new MuxClientError(
              "CONNECT_FAILED" as ClientErrorCode,
              `connect failed: ${err.message}`,
            ),
          );
        }
        this.rejectAll(err);
      });
      sock.on("close", () => {
        this.connected = false;
        this.rejectAll(new MuxClientError("RPC_ERROR" as ClientErrorCode, "socket closed"));
      });
    });
    return this.connectPromise;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch {
        // 깨진 한 줄 무시
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.method === "mux.streamChunk" && msg.params) {
      const p = msg.params as { streamId: string; chunk: string };
      this.streamHandler?.(p.streamId, p.chunk);
      return;
    }
    const id = msg.id;
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if ("error" in msg && msg.error) {
      pending.reject(buildErrorFromRpc(msg.error as { code: number; message: string; data?: unknown }));
      return;
    }
    pending.resolve(msg.result);
  }

  async call<R = unknown>(method: string, params: unknown): Promise<R> {
    if (!this.connected || !this.sock) {
      throw new MuxClientError("RPC_ERROR" as ClientErrorCode, "not connected");
    }
    const id = this.nextId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sock!.write(req);
    });
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (!this.sock) return;
    this.sock.end();
    this.sock = null;
    this.connected = false;
    this.connectPromise = null;
  }
}
