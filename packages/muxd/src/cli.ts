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

const VERSION = "0.1.7";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

function help(): void {
  console.log(`muxd — claude-mux daemon (v${VERSION})

Usage:
  muxd serve              Foreground daemon (Ctrl+C to stop)
                          MUXD_DEBUG=1 환경변수로 디버그 모드 (PTY 출력 기록)
  muxd status             Show daemon + claude CLI status
  muxd stop               Ask running daemon to shutdown
  muxd debug list         디버그 모드 데몬의 활성/종료 세션 목록
  muxd debug view <id>    세션 PTY 출력 live stream (Ctrl+C로 종료)
  muxd version
  muxd help

디버그 모드 사용 예시:
  # 데몬 띄우기 (디버그 ON)
  $ MUXD_DEBUG=1 muxd serve

  # 다른 터미널에서 세션 목록
  $ muxd debug list

  # 특정 세션 PTY 출력 보기 (새 cmd 창에서 하나씩 — Windows taskbar로 스위칭)
  $ muxd debug view <sessionId>
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

async function debugList(): Promise<void> {
  const r = (await sendRpc("mux.debugList", {})) as
    | {
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
      }
    | null;
  if (!r) {
    console.error("daemon not running or unreachable");
    process.exit(2);
  }
  if (!r.debug) {
    console.error("daemon is NOT in debug mode (set MUXD_DEBUG=1 and restart)");
    process.exit(2);
  }
  const sessions = r.sessions as Array<{
    sessionId: string;
    invoker: string;
    cwd: string;
    mode: string;
    createdAt: number;
    closed: boolean;
    ringLines: number;
  }>;
  if (sessions.length === 0) {
    console.log("(no sessions yet)");
    return;
  }
  for (const s of sessions) {
    const age = Math.floor((Date.now() - s.createdAt) / 1000);
    const status = s.closed ? "exited" : "alive";
    console.log(
      `[${status}] ${s.sessionId.slice(0, 8)}  ${s.invoker.padEnd(30)} ${s.mode.padEnd(10)} ${age}s  ring=${s.ringLines}`,
    );
    console.log(`         cwd: ${s.cwd}`);
  }
}

async function debugView(rawSessionId: string): Promise<void> {
  if (!rawSessionId) {
    console.error("usage: muxd debug view <sessionId or prefix>");
    process.exit(1);
  }
  // prefix → full id 자동 매칭 (debug list 출력에 prefix만 표시되므로 편의)
  let sessionId = rawSessionId;
  if (sessionId.length < 36) {
    const r = (await sendRpc("mux.debugList", {})) as
      | { sessions: Array<{ sessionId: string }> }
      | null;
    if (r?.sessions) {
      const match = r.sessions.filter((s) => s.sessionId.startsWith(rawSessionId));
      if (match.length === 1) {
        sessionId = match[0].sessionId;
      } else if (match.length > 1) {
        console.error(`prefix '${rawSessionId}' matches ${match.length} sessions:`);
        for (const s of match) console.error(`  ${s.sessionId}`);
        process.exit(1);
      } else {
        console.error(`no session matches prefix '${rawSessionId}'`);
        process.exit(1);
      }
    }
  }
  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection(daemonSocketPath());
    let buf = "";
    let printedRing = false;
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "mux.debugSubscribe",
          params: { sessionId },
        }) + "\n",
      );
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { ring?: string[]; closed?: boolean }; error?: { message: string }; method?: string; params?: { chunk?: string; sessionId?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // 첫 응답 — ring 출력
        if (msg.id === 1) {
          if (msg.error) {
            console.error(`error: ${msg.error.message}`);
            sock.destroy();
            return reject(new Error(msg.error.message));
          }
          const ring = msg.result?.ring ?? [];
          for (const l of ring) console.log(l);
          if (msg.result?.closed) {
            console.error("\n[session already exited]");
            sock.end();
            return resolve();
          }
          printedRing = true;
          console.error("--- live ---");
        }
        // 이후 notification
        if (msg.method === "mux.debugChunk") {
          process.stdout.write(msg.params?.chunk ?? "");
        } else if (msg.method === "mux.debugClose") {
          console.error("\n[session exited]");
          sock.end();
          return resolve();
        }
      }
    });
    sock.on("error", (e) => reject(e));
    sock.on("close", () => {
      if (printedRing) resolve();
    });
    process.on("SIGINT", () => {
      console.error("\n[detached]");
      sock.end();
      process.exit(0);
    });
  });
}

/** 일반 단발 RPC 호출 — sendRpc(method, params) → result. */
async function sendRpc(method: string, params: unknown, timeoutMs = 3000): Promise<unknown | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection(daemonSocketPath());
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, timeoutMs);
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
        resolve(msg.result ?? null);
      } catch {
        clearTimeout(timer);
        sock.destroy();
        resolve(null);
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
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
    case "debug": {
      const sub = args[1] ?? "help";
      if (sub === "list") {
        await debugList();
      } else if (sub === "view") {
        await debugView(args[2]);
      } else {
        console.error(`Usage: muxd debug list | muxd debug view <sessionId>`);
        process.exit(1);
      }
      break;
    }
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
