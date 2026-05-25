/**
 * @claude-mux/muxd — entry point.
 *
 * 모듈 구성:
 *  - core/   공통 인프라 (PtySession, parser, encoder, system-prompt)
 *  - bridge/ 패턴 A: on-demand 호출 (ask, stream, openSession)
 *  - runner/ 패턴 B: scheduled / loop (cron, skip 조건, hooks)
 *  - daemon/ IPC 서버 (Unix socket / named pipe) — 후속
 */

export * from "./core/index.js";
// bridge/runner는 채워지는 대로 export
