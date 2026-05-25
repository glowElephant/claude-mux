/**
 * @claude-mux/muxd — entry point.
 * v0.0.1 스캐폴드. PTY 매니저 / IPC / 세션 풀은 후속 커밋에서 채운다.
 */

export * from "./types.js";
export { locateClaude, ClaudeCliNotFoundError } from "./locate-claude.js";
