/**
 * @claude-mux/muxd/runner — 패턴 B: 예약/루프 실행.
 *
 * 사용 예 (currency-edge 옵티마이저 패턴):
 *   const handle = scheduleLoop({
 *     cwd: 'C:/Git/currency-edge',
 *     invoker: 'optimizer',
 *     mode: 'automation',
 *     allowedTools: 'Bash WebSearch WebFetch Read Edit Grep Glob',
 *     prompt: () => fs.readFileSync('prompts/optimize.md', 'utf8'),
 *     schedule: {
 *       cron: '0/10 9-15 * * 1-5',          // 주간 10분마다
 *       skipTimeRanges: ['23:00-24:00', '00:00-07:00'],
 *     },
 *     onResult: (text) => discord.send(text),
 *     onError: (err) => discord.alert(err.message),
 *   });
 *   // 종료
 *   await handle.stop();
 */

import { ask } from "../bridge/index.js";
import type { OpenSessionOpts, SchedulePolicy } from "../core/types.js";
import type { SendOpts } from "../core/pty-session.js";
import { nextRunAt } from "./schedule.js";

export interface ScheduleLoopOpts extends OpenSessionOpts, SendOpts {
  /** 호출마다 실행되는 prompt 생성. 매번 fresh prompt (예: 파일 다시 읽기) */
  prompt: () => string | Promise<string>;
  /** 스케줄 정책 — cron 또는 atTimes 또는 intervalMs + skip 조건 */
  schedule: SchedulePolicy;
  /** 응답 성공 시 hook */
  onResult?: (text: string, meta: RunMeta) => void | Promise<void>;
  /** 실패 시 hook (호출 자체 실패 — 타임아웃, PTY 사망 등) */
  onError?: (err: Error, meta: RunMeta) => void | Promise<void>;
  /** 스킵될 때 hook (디버그 / 모니터링용) */
  onSkip?: (reason: string, meta: RunMeta) => void | Promise<void>;
  /** 시작 즉시 1회 실행 후 스케줄. 기본 false */
  runOnStart?: boolean;
}

export interface RunMeta {
  startedAt: number;
  scheduledFor: number;
  invoker: string;
}

export interface LoopHandle {
  /** 다음 실행 예정 epoch ms. null이면 더 이상 실행 안 함. */
  readonly nextAt: number | null;
  /** 누적 실행 횟수 (성공 + 실패) */
  readonly runCount: number;
  /** 마지막 실행 결과 */
  readonly lastResult: "ok" | "error" | "skipped" | null;
  /** 루프 종료. 진행 중인 호출은 끝까지 기다림. */
  stop(): Promise<void>;
}

export function scheduleLoop(opts: ScheduleLoopOpts): LoopHandle {
  let stopped = false;
  let nextAt: number | null = null;
  let runCount = 0;
  let lastResult: LoopHandle["lastResult"] = null;
  let currentRun: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const meta: RunMeta = {
      startedAt: Date.now(),
      scheduledFor: nextAt ?? Date.now(),
      invoker: opts.invoker ?? "scheduled",
    };
    runCount++;
    try {
      const prompt = await opts.prompt();
      const text = await ask(prompt, {
        cwd: opts.cwd,
        invoker: opts.invoker,
        mode: opts.mode,
        allowedTools: opts.allowedTools,
        cols: opts.cols,
        rows: opts.rows,
        idleDeathMs: opts.idleDeathMs,
        maxMs: opts.maxMs,
      });
      lastResult = "ok";
      if (opts.onResult) await opts.onResult(text, meta);
    } catch (err) {
      lastResult = "error";
      if (opts.onError) await opts.onError(err as Error, meta);
    } finally {
      currentRun = null;
      scheduleNext();
    }
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    const ev = nextRunAt(opts.schedule, Date.now());
    nextAt = ev.nextAt;
    if (nextAt === null) return; // 더 이상 실행 안 함
    const delay = Math.max(0, nextAt - Date.now());
    timer = setTimeout(() => {
      currentRun = tick();
    }, delay);
  };

  if (opts.runOnStart) {
    currentRun = tick();
  } else {
    scheduleNext();
  }

  return {
    get nextAt() {
      return nextAt;
    },
    get runCount() {
      return runCount;
    },
    get lastResult() {
      return lastResult;
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (currentRun) await currentRun.catch(() => {});
    },
  };
}

export { nextRunAt, isSkipped } from "./schedule.js";
export type { ScheduleEval } from "./schedule.js";
