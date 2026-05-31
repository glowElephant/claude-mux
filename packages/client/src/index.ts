export { Client, Session } from "./client.js";
export type {
  OpenSessionOpts,
  SendOpts,
  AskOpts,
  ClientOpts,
  SessionMode,
} from "./client.js";
export { MuxClientError, BlockedError } from "./errors.js";
export type { ClientErrorCode } from "./errors.js";
export { defaultSocketPath } from "./socket-path.js";
