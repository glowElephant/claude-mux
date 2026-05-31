#!/usr/bin/env node
/**
 * muxd CLI — daemon 제어.
 *
 *   muxd serve    Foreground daemon. Ctrl+C로 종료.
 *   muxd status   running daemon + claude CLI 상태 확인 (소켓 ping 시도)
 *   muxd stop     running daemon shutdown 요청
 *   muxd version
 */

import net from "node:net";
import {
  locateClaude,
  ClaudeCliNotFoundError,
} from "./core/locate-claude.js";
import { DaemonServer } from "./daemon/server.js";
import { daemonSocketPath } from "./daemon/socket-path.js";

const VERSION = "0.1.2";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

function help(): void {
  console.log(`muxd — claude-mux daemon (v${VERSION})

Usage:
  muxd serve      Foreground daemon (Ctrl+C to stop)
  muxd status     Show daemon + claude CLI status
  muxd stop       Ask running daemon to shutdown
  muxd version
  muxd help
`);
}

async function serve(): Promise<void> {
  // Pre-check: claude CLI 있어야 의미가 있음
  try {
    locateClaude();
  } catch (e) {
    if (e instanceof ClaudeCliNotFoundError) {
      console.error(`claude CLI: NOT FOUND — ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const server = new DaemonServer({ startedAt: Date.now() });
  const sock = await server.listen();
  console.log(`muxd listening on ${sock} (pid ${process.pid})`);
  const onSig = async (sig: string): Promise<void> => {
    console.log(`\n${sig} received, shutting down...`);
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void onSig("SIGINT"));
  process.on("SIGTERM", () => void onSig("SIGTERM"));
}

async function pingDaemon(timeoutMs = 1000): Promise<{ ok: boolean; result?: unknown }> {
  return new Promise((resolve) => {
    const sock = net.createConnection(daemonSocketPath());
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ ok: false });
    }, timeoutMs);
    let buffer = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      const req =
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mux.status", params: {} }) +
        "\n";
      sock.write(req);
    });
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      const line = buffer.slice(0, idx).trim();
      try {
        const msg = JSON.parse(line) as { result?: unknown };
        clearTimeout(timer);
        sock.end();
        resolve({ ok: true, result: msg.result });
      } catch {
        clearTimeout(timer);
        sock.destroy();
        resolve({ ok: false });
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false });
    });
  });
}

async function status(): Promise<void> {
  try {
    const path = locateClaude();
    console.log(`claude CLI: ${path}`);
  } catch (e) {
    if (e instanceof ClaudeCliNotFoundError) {
      console.error(`claude CLI: NOT FOUND`);
      console.error(`  ${e.message}`);
    } else {
      throw e;
    }
  }
  const r = await pingDaemon();
  if (r.ok) {
    console.log(`daemon: running — ${JSON.stringify(r.result)}`);
  } else {
    console.log(`daemon: not running (socket: ${daemonSocketPath()})`);
  }
}

async function stop(): Promise<void> {
  await new Promise<void>((resolve) => {
    const sock = net.createConnection(daemonSocketPath());
    const timer = setTimeout(() => {
      sock.destroy();
      resolve();
    }, 3000);
    sock.on("connect", () => {
      sock.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mux.shutdown", params: {} }) +
          "\n",
      );
    });
    sock.on("data", () => {
      clearTimeout(timer);
      sock.end();
      resolve();
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  console.log("shutdown requested");
}

async function main(): Promise<void> {
  switch (cmd) {
    case "serve":
      await serve();
      break;
    case "status":
      await status();
      break;
    case "stop":
      await stop();
      break;
    case "version":
      console.log(VERSION);
      break;
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
