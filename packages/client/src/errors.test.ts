import { describe, it, expect } from "vitest";
import { BlockedError, MuxClientError, buildErrorFromRpc } from "./errors.js";

describe("buildErrorFromRpc", () => {
  it("returns BlockedError for code 1010 with full data", () => {
    const err = buildErrorFromRpc({
      code: 1010,
      message: "blocked",
      data: { reason: "no internet", sessionId: "s-1", rawReply: "MUX_BLOCKED: no internet" },
    });
    expect(err).toBeInstanceOf(BlockedError);
    const b = err as BlockedError;
    expect(b.code).toBe("BLOCKED");
    expect(b.reason).toBe("no internet");
    expect(b.rawReply).toBe("MUX_BLOCKED: no internet");
    expect(b.sessionId).toBe("s-1");
  });

  it("returns BlockedError with fallback reason when data missing", () => {
    const err = buildErrorFromRpc({ code: 1010, message: "blocked" });
    expect(err).toBeInstanceOf(BlockedError);
    expect((err as BlockedError).reason).toBe("(no reason)");
  });

  it.each([
    [1001, "SESSION_NOT_FOUND"],
    [1002, "SESSION_DEAD"],
    [1003, "TIMEOUT"],
    [1020, "PTY_SPAWN_FAILED"],
    [1021, "CLAUDE_NOT_FOUND"],
  ])("maps rpc code %d to %s", (rpcCode, expectedCode) => {
    const err = buildErrorFromRpc({ code: rpcCode, message: "x" });
    expect(err).toBeInstanceOf(MuxClientError);
    expect(err.code).toBe(expectedCode);
    expect(err.rpcCode).toBe(rpcCode);
  });

  it("falls back to RPC_ERROR for unknown codes", () => {
    const err = buildErrorFromRpc({ code: 9999, message: "weird" });
    expect(err.code).toBe("RPC_ERROR");
    expect(err.rpcCode).toBe(9999);
  });
});

describe("BlockedError", () => {
  it("is catchable as MuxClientError and Error", () => {
    const e = new BlockedError("s", "r", "MUX_BLOCKED: r");
    expect(e).toBeInstanceOf(MuxClientError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BlockedError");
  });
});
