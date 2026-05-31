/**
 * 통합 — in-process DaemonServer + Client + 실제 claude CLI round-trip.
 *
 * 환경:
 *  - MUX_INTEGRATION=1
 *  - claude CLI가 PATH에 있고 호스트가 Pro/Max 로그인 상태
 *
 * 봇 한도 보호: 1 round-trip만. cooldown 5s.
 */

import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DaemonServer } from "@claude-mux/muxd/daemon";
import { Client } from "./index.js";

const ENABLED = process.env.MUX_INTEGRATION === "1";
const d = ENABLED ? describe : describe.skip;

function tempSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\muxd-client-test-${process.pid}-${Date.now()}`;
  }
  return path.join(os.tmpdir(), `muxd-client-test-${process.pid}-${Date.now()}.sock`);
}

d("Client + DaemonServer integration (real claude CLI)", () => {
  let server: DaemonServer | null = null;
  let client: Client | null = null;
  let socketPath = "";

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
    if (server) {
      await server.stop().catch(() => {});
      server = null;
    }
    if (process.platform !== "win32" && socketPath) {
      try {
        fs.unlinkSync(socketPath);
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 5_000));
  });

  it(
    "ask: roundtrip through daemon — returns exact reply",
    async () => {
      socketPath = tempSocketPath();
      server = new DaemonServer({ socketPath });
      await server.listen();
      client = new Client({ socketPath, autoSpawn: false });
      const text = await client.ask('respond with exactly: "OK-DAEMON"', {
        cwd: process.cwd(),
        invoker: "client-integration-test",
        mode: "automation",
        idleDeathMs: 60_000,
        maxMs: 120_000,
      });
      expect(text).toMatch(/OK-DAEMON/);
    },
    { timeout: 180_000 },
  );

  it(
    "status: returns daemon info before any session",
    async () => {
      socketPath = tempSocketPath();
      server = new DaemonServer({ socketPath, startedAt: Date.now() - 2_000 });
      await server.listen();
      client = new Client({ socketPath, autoSpawn: false });
      const s = await client.status();
      expect(s.pid).toBe(process.pid);
      expect(s.sessions).toBe(0);
      expect(s.uptimeMs).toBeGreaterThanOrEqual(2_000);
      expect(s.version).toMatch(/^\d+\.\d+\.\d+/);
    },
    { timeout: 30_000 },
  );
});
