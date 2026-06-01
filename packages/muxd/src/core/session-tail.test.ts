import { describe, it, expect } from "vitest";
import {
  encodeProjectDir,
  extractAssistantText,
  extractToolUseBlocks,
  shouldEmitDone,
  type JsonlMessage,
} from "./session-tail.js";

describe("encodeProjectDir", () => {
  it("encodes Windows path (colon + backslash → '--')", () => {
    expect(encodeProjectDir("C:\\Git\\claude-mux\\poc")).toBe(
      "C--Git-claude-mux-poc",
    );
  });
  it("encodes POSIX path", () => {
    expect(encodeProjectDir("/home/gksdk/proj")).toBe("-home-gksdk-proj");
  });
  it("handles mixed separators", () => {
    expect(encodeProjectDir("C:\\Git/foo\\bar")).toBe("C--Git-foo-bar");
  });
  it("handles forward-slash drive path", () => {
    expect(encodeProjectDir("C:/Git/foo")).toBe("C--Git-foo");
  });
});

describe("extractAssistantText", () => {
  it("joins text blocks in order", () => {
    const msg: JsonlMessage = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    };
    expect(extractAssistantText(msg)).toBe("Hello world");
  });

  it("ignores tool_use blocks for text", () => {
    const msg: JsonlMessage = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "before" },
          { type: "tool_use", id: "1", name: "Bash", input: { cmd: "ls" } },
          { type: "text", text: "after" },
        ],
      },
    };
    expect(extractAssistantText(msg)).toBe("beforeafter");
  });

  it("handles string content (legacy form)", () => {
    const msg: JsonlMessage = {
      type: "assistant",
      message: { content: "just a string" },
    };
    expect(extractAssistantText(msg)).toBe("just a string");
  });

  it("returns empty when no content", () => {
    const msg: JsonlMessage = { type: "assistant", message: {} };
    expect(extractAssistantText(msg)).toBe("");
  });
});

describe("shouldEmitDone (v0.1.6 fix)", () => {
  it.each(["end_turn", "stop_sequence", "max_tokens"] as const)(
    "returns true for %s (response really finished)",
    (sr) => {
      expect(shouldEmitDone(sr)).toBe(true);
    },
  );

  it("returns false for tool_use (model will continue after tool result)", () => {
    // v0.1.5까지 버그: tool_use도 done 처리 → 호출자에 빈 응답 반환
    expect(shouldEmitDone("tool_use")).toBe(false);
  });

  it("returns false for null/undefined (response still in progress)", () => {
    expect(shouldEmitDone(null)).toBe(false);
    expect(shouldEmitDone(undefined)).toBe(false);
  });

  it("returns false for unknown stop_reason values", () => {
    expect(shouldEmitDone("some_future_reason")).toBe(false);
    expect(shouldEmitDone("")).toBe(false);
  });
});

describe("extractToolUseBlocks", () => {
  it("returns only tool_use blocks", () => {
    const msg: JsonlMessage = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "x" },
          { type: "tool_use", id: "1", name: "Bash", input: { cmd: "ls" } },
          { type: "tool_use", id: "2", name: "Read", input: { path: "/a" } },
        ],
      },
    };
    const blocks = extractToolUseBlocks(msg);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].name).toBe("Bash");
    expect(blocks[1].name).toBe("Read");
  });

  it("returns empty when content is string", () => {
    expect(extractToolUseBlocks({ message: { content: "x" } })).toEqual([]);
  });
});
