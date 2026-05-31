import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { daemonSocketPath } from "./socket-path.js";

const originalEnv = { ...process.env };
const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

describe("daemonSocketPath", () => {
  beforeEach(() => {
    delete process.env.XDG_RUNTIME_DIR;
    delete process.env.USERNAME;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    setPlatform(originalPlatform);
  });

  it("uses XDG_RUNTIME_DIR on POSIX if set", () => {
    setPlatform("linux");
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    // path.join은 OS native separator를 쓰므로 같은 join 결과로 비교 (실 OS에선 일관)
    expect(daemonSocketPath()).toBe(path.join("/run/user/1000", "muxd.sock"));
  });

  it("falls back to /tmp/muxd-<uid>.sock on POSIX", () => {
    setPlatform("linux");
    const p = daemonSocketPath();
    expect(p).toMatch(/muxd-\d+\.sock$/);
  });

  it("uses named pipe with username on Windows", () => {
    setPlatform("win32");
    process.env.USERNAME = "Alice";
    expect(daemonSocketPath()).toBe("\\\\.\\pipe\\muxd-alice");
  });

  it("falls back to 'default' when USERNAME unset on Windows", () => {
    setPlatform("win32");
    expect(daemonSocketPath()).toBe("\\\\.\\pipe\\muxd-default");
  });
});
