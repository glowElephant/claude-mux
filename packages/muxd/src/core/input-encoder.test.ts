import { describe, it, expect } from "vitest";
import { encodeForPty } from "./input-encoder.js";

describe("encodeForPty (flatten)", () => {
  it("appends submit CR", () => {
    expect(encodeForPty("hello")).toBe("hello\r");
  });

  it("flattens \\n to space", () => {
    expect(encodeForPty("line1\nline2")).toBe("line1 line2\r");
  });

  it("flattens \\r\\n + collapses spaces", () => {
    expect(encodeForPty("line1\r\nline2\r\nline3")).toBe("line1 line2 line3\r");
  });

  it("strips Ctrl+C", () => {
    expect(encodeForPty("ab\x03cd")).toBe("abcd\r");
  });

  it("strips Ctrl+D and Ctrl+Z", () => {
    expect(encodeForPty("a\x04b\x1Ac")).toBe("abc\r");
  });

  it("keeps tab as whitespace (collapsed)", () => {
    expect(encodeForPty("a\tb")).toBe("a b\r");
  });

  it("collapses excessive whitespace from mixed newlines", () => {
    expect(encodeForPty("a\n\n\nb")).toBe("a b\r");
  });
});

describe("encodeForPty (bracketed-paste)", () => {
  it("wraps body with bracketed-paste sequences and preserves newlines", () => {
    const out = encodeForPty("line1\nline2", { multiline: "bracketed-paste" });
    expect(out).toBe("\x1B[200~line1\nline2\x1B[201~\r");
  });

  it("normalizes CRLF to LF inside bracketed paste", () => {
    const out = encodeForPty("a\r\nb", { multiline: "bracketed-paste" });
    expect(out).toBe("\x1B[200~a\nb\x1B[201~\r");
  });
});
