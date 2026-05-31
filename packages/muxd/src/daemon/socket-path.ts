/**
 * Platform-specific IPC socket path resolver.
 *
 * Linux/macOS: Unix domain socket
 *   - $XDG_RUNTIME_DIR/muxd.sock if set
 *   - else /tmp/muxd-<uid>.sock
 *
 * Windows: Named pipe
 *   - \\.\pipe\muxd-<username>
 *
 * 사용자별로 분리해서 같은 호스트의 다른 계정 데몬과 충돌 안 함.
 */

import os from "node:os";
import path from "node:path";

export function daemonSocketPath(): string {
  if (process.platform === "win32") {
    const user = process.env.USERNAME || "default";
    return `\\\\.\\pipe\\muxd-${user.toLowerCase()}`;
  }
  // POSIX
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) return path.join(runtimeDir, "muxd.sock");
  const uid = process.getuid ? process.getuid() : 0;
  return path.join(os.tmpdir(), `muxd-${uid}.sock`);
}
