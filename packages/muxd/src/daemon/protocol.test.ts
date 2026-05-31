import { describe, it, expect } from "vitest";
import { muxCodeToJsonRpc, JsonRpcErrorCode } from "./protocol.js";

describe("muxCodeToJsonRpc", () => {
  it.each([
    ["SESSION_NOT_FOUND", JsonRpcErrorCode.SessionNotFound],
    ["SESSION_DEAD", JsonRpcErrorCode.SessionDead],
    ["TIMEOUT", JsonRpcErrorCode.Timeout],
    ["BLOCKED", JsonRpcErrorCode.Blocked],
    ["PTY_SPAWN_FAILED", JsonRpcErrorCode.PtySpawnFailed],
    ["CLAUDE_NOT_FOUND", JsonRpcErrorCode.ClaudeNotFound],
    ["AUTH_REQUIRED", JsonRpcErrorCode.InternalError],
    ["QUEUE_FULL", JsonRpcErrorCode.InternalError],
  ] as const)("%s -> %d", (input, expected) => {
    expect(muxCodeToJsonRpc(input)).toBe(expected);
  });
});
