/**
 * @claude-mux/muxd/bridge — 패턴 A: on-demand 호출 API.
 *
 * 3가지 형태:
 *  - ask(prompt, opts)      단발 호출. PTY 세션을 매번 새로 + 자동 close.
 *                           (drop-in for `subprocess.run(["claude", "-p", ...])`)
 *  - stream(prompt, opts)   AsyncIterable로 응답 chunk를 yield.
 *                           v0.1.0에서는 응답 전체가 한 chunk로 옴 (claude jsonl은 응답 단위).
 *                           진짜 토큰 스트리밍은 후속.
 *  - openSession(opts)      재사용 가능한 Session 핸들 반환.
 *                           컨텍스트 유지가 필요한 경우 (옵티마이저 메모리, Council 회의실).
 *
 * 모두 in-process. 데몬 IPC는 v0.1.1+에서 추가 예정.
 */

import { PtySession } from "../core/pty-session.js";
import type { OpenSessionOpts, SessionMode } from "../core/types.js";
import type { SendOpts } from "../core/pty-session.js";
import { wrapSession, type Session } from "./session-handle.js";

export type { Session, SessionEvents } from "./session-handle.js";

export interface AskOpts extends Omit<OpenSessionOpts, "mode">, SendOpts {
  /** 단발 호출 기본 모드는 automation */
  mode?: SessionMode;
}

/**
 * 단발 호출. PTY 세션 새로 spawn → init → send → close.
 *
 * 비용: claude TUI 부팅 시간 (약 3~10초). 짧은 호출 반복 시 oneshot보다
 * openSession + send 재사용 권장.
 */
export async function ask(prompt: string, opts: AskOpts): Promise<string> {
  const session = await openSession({
    ...opts,
    mode: opts.mode ?? "automation",
  });
  try {
    return await session.send(prompt, {
      idleDeathMs: opts.idleDeathMs,
      maxMs: opts.maxMs,
    });
  } finally {
    await session.close();
  }
}

/**
 * 재사용 세션. 호출자가 명시적 close 책임.
 * 같은 세션에 send 여러 번 = 컨텍스트 유지.
 */
export async function openSession(opts: OpenSessionOpts): Promise<Session> {
  const p = new PtySession(opts);
  try {
    await p.init({ allowedTools: opts.allowedTools });
  } catch (err) {
    await p.close();
    throw err;
  }
  return wrapSession(p);
}

/**
 * 응답을 AsyncIterable chunk로. v0.1.0에서는 응답 전체가 한 chunk
 * (claude jsonl이 응답 단위 기록). 진짜 토큰 스트리밍은 후속.
 */
export async function* stream(
  prompt: string,
  opts: AskOpts,
): AsyncGenerator<string, void, unknown> {
  const text = await ask(prompt, opts);
  if (text) yield text;
}
