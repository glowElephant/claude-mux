/**
 * @claude-mux/muxd/daemon — JSON-RPC daemon over Unix socket / Named pipe.
 */

export { DaemonServer } from "./server.js";
export { daemonSocketPath } from "./socket-path.js";
export * from "./protocol.js";
export { attachNdjsonReader, writeMessage } from "./framing.js";
