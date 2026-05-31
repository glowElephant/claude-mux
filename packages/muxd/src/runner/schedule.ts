/**
 * SchedulePolicy 평가 — 다음 실행 시각 계산 + skip 조건 적용.
 *
 * cron / atTimes / intervalMs 중 하나를 base로, onWeekdays/skipTimeRanges/skipDates를
 * skip 필터로 적용.
 */

import { CronExpressionParser } from "cron-parser";
import type { SchedulePolicy, Weekday } from "../core/types.js";

export interface ScheduleEval {
  /** 다음 실행 시각 (epoch ms). null이면 더 이상 실행 안 함. */
  nextAt: number | null;
  /** skip된 후보가 있었으면 그 사유 (디버그용) */
  skipped?: string[];
}

/**
 * 주어진 시점 (from) 이후 가장 가까운 다음 실행 시각을 찾는다.
 * skip 조건에 걸리면 그 다음 후보를 계속 본다 (최대 N회 시도).
 */
export function nextRunAt(
  policy: SchedulePolicy,
  from: number = Date.now(),
  maxIterations = 200,
): ScheduleEval {
  const skipped: string[] = [];
  let cursor = from;

  for (let i = 0; i < maxIterations; i++) {
    const candidate = computeBaseCandidate(policy, cursor);
    if (candidate === null) return { nextAt: null, skipped };
    if (candidate <= cursor) {
      // 같은 후보 무한 루프 방지 — 1초 밀어서 다음 candidate
      cursor = cursor + 1000;
      continue;
    }

    const skipReason = isSkipped(candidate, policy);
    if (!skipReason) {
      return { nextAt: candidate, skipped };
    }
    skipped.push(`${new Date(candidate).toISOString()}: ${skipReason}`);
    cursor = candidate + 1000; // 같은 후보 다시 안 찾도록
  }
  return { nextAt: null, skipped };
}

function computeBaseCandidate(policy: SchedulePolicy, from: number): number | null {
  if (policy.cron) {
    try {
      const it = CronExpressionParser.parse(policy.cron, {
        currentDate: new Date(from),
        tz: policy.timezone,
      });
      return it.next().getTime();
    } catch {
      return null;
    }
  }

  if (policy.atTimes && policy.atTimes.length > 0) {
    return nextAtTime(policy.atTimes, from, policy.timezone);
  }

  if (policy.intervalMs && policy.intervalMs > 0) {
    return from + policy.intervalMs;
  }

  return null;
}

/**
 * "HH:mm" 형식 시각 배열 중 from 이후 가장 가까운 시각.
 * 오늘 안에 있으면 오늘, 없으면 내일 첫 시각.
 */
function nextAtTime(
  atTimes: string[],
  from: number,
  _timezone?: string,
): number | null {
  // TODO: timezone 정확한 적용은 후속 — 현재는 시스템 TZ 사용
  const parsed: { h: number; m: number }[] = [];
  for (const t of atTimes) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) continue;
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) continue;
    parsed.push({ h, m: mm });
  }
  if (parsed.length === 0) return null;

  const candidates: number[] = [];
  const today = new Date(from);
  for (const p of parsed) {
    const d = new Date(today);
    d.setHours(p.h, p.m, 0, 0);
    if (d.getTime() > from) candidates.push(d.getTime());
    // 내일 후보도 추가 (오늘 다 지났을 때)
    const tomorrow = new Date(d);
    tomorrow.setDate(tomorrow.getDate() + 1);
    candidates.push(tomorrow.getTime());
  }
  candidates.sort((a, b) => a - b);
  return candidates[0] ?? null;
}

export function isSkipped(at: number, policy: SchedulePolicy): string | null {
  const d = new Date(at);

  if (policy.onWeekdays && policy.onWeekdays.length > 0) {
    const wd = d.getDay() as Weekday;
    if (!policy.onWeekdays.includes(wd)) return `weekday ${wd} not in allowed list`;
  }

  if (policy.skipDates && policy.skipDates.length > 0) {
    const iso = toIsoDate(d);
    if (policy.skipDates.includes(iso)) return `date ${iso} in skipDates`;
  }

  if (policy.skipTimeRanges && policy.skipTimeRanges.length > 0) {
    const mins = d.getHours() * 60 + d.getMinutes();
    for (const range of policy.skipTimeRanges) {
      const r = parseRange(range);
      if (!r) continue;
      if (mins >= r.startMin && mins < r.endMin) {
        return `time ${formatHm(mins)} in skip range ${range}`;
      }
    }
  }

  return null;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseRange(range: string): { startMin: number; endMin: number } | null {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range.trim());
  if (!m) return null;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  // 24:00 끝점 허용
  if (sh < 0 || sh > 24 || sm < 0 || sm > 59 || eh < 0 || eh > 24 || em < 0 || em > 59)
    return null;
  return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
}

function formatHm(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
