import { describe, it, expect } from "vitest";
import { parseFrame, extractUsage, extractAssistantText } from "./tui-parser.js";

describe("extractUsage", () => {
  it("parses TUI footer counter", () => {
    expect(extractUsage("5시간:20%(0h7m) 7일:38%(2d11h)")).toEqual({
      fiveHourPct: 20,
      sevenDayPct: 38,
    });
  });
  it("returns null when absent", () => {
    expect(extractUsage("hello world")).toBeNull();
  });
});

describe("parseFrame", () => {
  it("flags authed when Opus + Claude Max line present", () => {
    const text = "Opus 4.7 (1M context) with me… · Claude Max · email@x.com";
    const f = parseFrame(text);
    expect(f.authed).toBe(true);
  });
  it("flags promptReady when ❯ marker at line start", () => {
    const text = "some output\n❯ \nfooter";
    const f = parseFrame(text);
    expect(f.promptReady).toBe(true);
  });
});

describe("extractAssistantText", () => {
  it("removes input echo and footer noise", () => {
    const raw = [
      "╭───ClaudeCodev2.1.150───╮",
      "Welcome back 한아!",
      "Opus 4.7 (1M context) | Claude Max · email",
      "❯ ping 1 — reply with just pong 1",
      "Thundering… (3s · ↓1 tokens)",
      "pong 1",
      "5시간:20%(0h7m) 7일:38%(2d11h)",
    ].join("\n");
    const out = extractAssistantText(raw);
    expect(out).toBe("pong 1");
  });

  it("survives empty/spinner-only output", () => {
    const raw = "Thundering…\nThinking…\n";
    expect(extractAssistantText(raw)).toBe("");
  });
});
