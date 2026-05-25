import { describe, it, expect } from "vitest";
import {
  encodeProjectDir,
  extractAssistantText,
  extractToolUseBlocks,
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
