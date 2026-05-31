import { describe, it, expect } from "vitest";
import { BlockedError, matchBlocked } from "./errors.js";

describe("matchBlocked", () => {
  it("returns reason when body starts with MUX_BLOCKED:", () => {
    expect(matchBlocked("MUX_BLOCKED: cannot access future data")).toBe(
      "cannot access future data",
    );
  });

  it("trims whitespace around reason", () => {
    expect(matchBlocked("MUX_BLOCKED:   file missing   ")).toBe("file missing");
  });

  it("returns reason when MUX_BLOCKED: appears on its own line (last line)", () => {
    // 모델이 한두 줄 전문을 두고 마지막 줄에 약속어를 출력하는 경우.
    const text = "Some preamble I cannot avoid.\nMUX_BLOCKED: no network";
    expect(matchBlocked(text)).toBe("no network");
  });

  it("returns reason when MUX_BLOCKED: appears on its own line in middle", () => {
    const text = "preamble\nMUX_BLOCKED: blocked\ntrailing noise";
    expect(matchBlocked(text)).toBe("blocked");
  });

  it("handles empty reason (model output `MUX_BLOCKED:` with nothing after)", () => {
    expect(matchBlocked("MUX_BLOCKED:")).toBe("(no reason given)");
    expect(matchBlocked("MUX_BLOCKED:   ")).toBe("(no reason given)");
  });

  it("returns null for normal response not containing the token", () => {
    expect(matchBlocked("just a normal reply")).toBeNull();
    expect(matchBlocked("")).toBeNull();
  });

  it("does NOT match if MUX_BLOCKED: appears mid-line (inside prose)", () => {
    // 우연한 등장 방지 — 줄 시작이 아니면 무시.
    expect(
      matchBlocked("The phrase MUX_BLOCKED: usually means... not here."),
    ).toBeNull();
  });

  it("matches with CRLF line endings (Windows)", () => {
    expect(matchBlocked("preamble\r\nMUX_BLOCKED: foo\r\n")).toBe("foo");
  });
});

describe("BlockedError", () => {
  it("carries code, sessionId, reason, rawReply", () => {
    const err = new BlockedError("sess-1", "no internet", "MUX_BLOCKED: no internet");
    expect(err.code).toBe("BLOCKED");
    expect(err.sessionId).toBe("sess-1");
    expect(err.reason).toBe("no internet");
    expect(err.rawReply).toBe("MUX_BLOCKED: no internet");
    expect(err.message).toContain("sess-1");
    expect(err.message).toContain("no internet");
    expect(err.name).toBe("BlockedError");
  });

  it("is an Error instance (catchable with try/catch)", () => {
    const err = new BlockedError("s", "r", "MUX_BLOCKED: r");
    expect(err).toBeInstanceOf(Error);
  });
});
