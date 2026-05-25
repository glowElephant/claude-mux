/**
 * Session — Bridge가 호출자에게 노출하는 핸들.
 * PtySession을 wrap해서 내부 구현(PTY, jsonl tail 등)을 숨긴다.
 *
 * 향후 daemon IPC가 들어와도 같은 인터페이스로 wrapping될 예정.
 */

import type { PtySession, SendOpts } from "../core/pty-session.js";
import type { UsageSnapshot } from "../core/tui-parser.js";
import type { JsonlAssistantContentBlock } from "../core/session-tail.js";

export interface SessionEvents {
  usage: (u: UsageSnapshot) => void;
  toolUse: (block: JsonlAssistantContentBlock) => void;
  exit: (code: number | null) => void;
  warn: (err: Error) => void;
}

export interface Session {
  readonly id: string;
  send(prompt: string, opts?: SendOpts): Promise<string>;
  close(): Promise<void>;
  on<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): this;
  off<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): this;
}

/** PtySession을 Session 인터페이스로 wrap. PtySession 자체는 export하지 않음. */
export function wrapSession(p: PtySession): Session {
  return {
    id: p.id,
    send: (prompt, opts) => p.send(prompt, opts),
    close: () => p.close(),
    on(event, listener) {
      p.on(event, listener as (...args: unknown[]) => void);
      return this;
    },
    off(event, listener) {
      p.off(event, listener as (...args: unknown[]) => void);
      return this;
    },
  };
}
