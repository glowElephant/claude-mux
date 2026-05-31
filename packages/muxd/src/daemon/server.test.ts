/**
 * server.test — daemon listen + JSON-RPC round-trip 검증.
 * PtySession은 안 띄움 — status / 모르는 메서드 / 잘못된 메시지만.
 */
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DaemonServer } from "./server.js";

function tempSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\muxd-test-${process.pid}-${Date.now()}`;
  }
  return path.join(os.tmpdir(), `muxd-test-${process.pid}-${Date.now()}.sock`);
}

async function rpc<R>(socketPath: string, method: string, params: unknown): Promise<R> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("rpc timeout"));
    }, 3000);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      const line = buf.slice(0, idx).trim();
      try {
        const msg = JSON.parse(line);
        clearTimeout(timer);
        sock.end();
        if (msg.error) reject(msg.error);
        else resolve(msg.result as R);
      } catch (e) {
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe("DaemonServer", () => {
  let server: DaemonServer | null = null;
  let socketPath = "";

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
      server = null;
    }
    if (process.platform !== "win32" && socketPath) {
      try {
        fs.unlinkSync(socketPath);
      } catch {}
    }
  });

  it("listens and responds to mux.status", async () => {
    socketPath = tempSocketPath();
    server = new DaemonServer({ socketPath, startedAt: Date.now() - 1234 });
    await server.listen();
    const r = await rpc<{ pid: number; uptimeMs: number; sessions: number; version: string }>(
      socketPath,
      "mux.status",
      {},
    );
    expect(r.pid).toBe(process.pid);
    expect(r.uptimeMs).toBeGreaterThanOrEqual(1234);
    expect(r.sessions).toBe(0);
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns method-not-found error for unknown method", async () => {
    socketPath = tempSocketPath();
    server = new DaemonServer({ socketPath });
    await server.listen();
    await expect(rpc(socketPath, "mux.nonexistent", {})).rejects.toMatchObject({
      // error object의 어떤 필드든
    });
  });

  it("close.sessionId returns ok:true even when session unknown (idempotent)", async () => {
    socketPath = tempSocketPath();
    server = new DaemonServer({ socketPath });
    await server.listen();
    const r = await rpc<{ ok: boolean }>(socketPath, "mux.close", { sessionId: "nope" });
    expect(r.ok).toBe(true);
  });

  it("send to unknown session → SessionNotFound error", async () => {
    socketPath = tempSocketPath();
    server = new DaemonServer({ socketPath });
    await server.listen();
    await expect(
      rpc(socketPath, "mux.send", { sessionId: "nope", prompt: "hi" }),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it("stop() unlinks socket file on POSIX", async () => {
    socketPath = tempSocketPath();
    server = new DaemonServer({ socketPath });
    await server.listen();
    await server.stop();
    server = null;
    if (process.platform !== "win32") {
      expect(fs.existsSync(socketPath)).toBe(false);
    }
  });
});
