/**
 * @claude-mux/muxd/core — 공통 인프라.
 * Bridge(on-demand)와 Runner(scheduled/loop)가 공유하는 저수준 빌딩블록.
 */

export * from "./types.js";
export { locateClaude, ClaudeCliNotFoundError } from "./locate-claude.js";
export { parseFrame, extractUsage, extractAssistantText } from "./tui-parser.js";
export type { UsageSnapshot, ParsedFrame } from "./tui-parser.js";
export { encodeForPty, INTERRUPT_ESC, INTERRUPT_CTRL_C } from "./input-encoder.js";
export { buildSystemPrompt } from "./system-prompt.js";
export type { SystemPromptOpts } from "./system-prompt.js";
export {
  PtySession,
  SessionDeadError,
  IdleDeathError,
  MaxDurationError,
  HandshakeWarning,
} from "./pty-session.js";
export type { SendOpts } from "./pty-session.js";
