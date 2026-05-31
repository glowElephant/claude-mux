/**
 * Auto-spawn helper — 첫 호출 시 데몬이 없으면 백그라운드로 띄운다.
 *
 * 흐름:
 *  1. socketPath에 연결 시도 (짧은 timeout)
 *  2. 실패 → muxd 바이너리 찾아서 `muxd serve` detached spawn
 *  3. 데몬 ready 폴링 (status ping)
 *  4. 호출자에게 connect 가능 시점 알림
 *
 * 바이너리 위치 우선순위:
 *   1. opts.muxdPath
 *   2. process.env.MUXD_BIN
 *   3. PATH에서 `muxd` (where/which)
 *
 * Note: 호출자 프로세스가 죽어도 데몬은 살아남도록 detach.
 */

import { spawn } from "node:child_process";
import net from "node:net";
import { execSync } from "node:child_process";
import { MuxClientError } from "./errors.js";

export interface AutoSpawnOpts {
  socketPath: string;
  /** muxd 바이너리 경로 명시 */
  muxdPath?: string;
  /** spawn 후 데몬 ready 폴링 timeout (ms). 기본 5000 */
  spawnTimeoutMs?: number;
}

/** 데몬이 listening 중인지 확인 — 짧은 connect 시도 */
export async function isDaemonRunning(
  socketPath: string,
  timeoutMs = 300,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.on("connect", () => {
      clearTimeout(timer);
      sock.end();
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function findMuxdBinary(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.MUXD_BIN) return process.env.MUXD_BIN;
  // PATH lookup
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const out = execSync(`${finder} muxd`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first) return first;
  } catch {}
  throw new MuxClientError(
    "DAEMON_NOT_FOUND",
    "muxd binary not found. Set MUXD_BIN or pass opts.muxdPath, or install @claude-mux/muxd globally.",
  );
}

/** muxd serve를 detached로 띄우고 ready 될 때까지 대기. */
export async function spawnDaemon(opts: AutoSpawnOpts): Promise<void> {
  const bin = findMuxdBinary(opts.muxdPath);
  const timeoutMs = opts.spawnTimeoutMs ?? 5000;
  // Windows에서 muxd는 .cmd shim일 수 있음 — shell: true로 안전하게
  const child = spawn(bin, ["serve"], {
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  child.unref(); // 호출자가 죽어도 데몬 생존

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isDaemonRunning(opts.socketPath, 200)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new MuxClientError(
    "CONNECT_FAILED",
    `muxd spawned but not responding on ${opts.socketPath} within ${timeoutMs}ms`,
  );
}
