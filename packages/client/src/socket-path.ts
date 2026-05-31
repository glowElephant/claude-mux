/**
 * Client-side socket path — daemon과 동일한 규칙으로 위치 결정.
 *
 * Linux/Mac: $XDG_RUNTIME_DIR/muxd.sock or /tmp/muxd-<uid>.sock
 * Windows: \\.\pipe\muxd-<user>
 *
 * muxd/daemon/socket-path.ts와 중복이지만 client가 muxd에 의존하지 않게 분리.
 * 규칙이 바뀌면 둘 다 갱신.
 */

import os from "node:os";
import path from "node:path";

export function defaultSocketPath(): string {
  if (process.platform === "win32") {
    const user = process.env.USERNAME || "default";
    return `\\\\.\\pipe\\muxd-${user.toLowerCase()}`;
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) return path.join(runtimeDir, "muxd.sock");
  const uid = process.getuid ? process.getuid() : 0;
  return path.join(os.tmpdir(), `muxd-${uid}.sock`);
}
