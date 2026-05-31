import { describe, it, expect } from "vitest";
import { nextRunAt, isSkipped } from "./schedule.js";

// 결정적 테스트를 위해 명시적 from 시각 사용 (2026-05-25 Mon 09:00:00 local)
const MON_0900 = new Date(2026, 4, 25, 9, 0, 0).getTime();

describe("nextRunAt — intervalMs", () => {
  it("returns from + interval", () => {
    expect(nextRunAt({ intervalMs: 60_000 }, MON_0900).nextAt).toBe(
      MON_0900 + 60_000,
    );
  });
});

describe("nextRunAt — atTimes", () => {
  it("picks next today's time", () => {
    const r = nextRunAt({ atTimes: ["09:30", "15:30"] }, MON_0900);
    const d = new Date(r.nextAt!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
  });

  it("rolls to tomorrow when all today's times passed", () => {
    const lateNight = new Date(2026, 4, 25, 23, 0, 0).getTime();
    const r = nextRunAt({ atTimes: ["09:30", "15:30"] }, lateNight);
    const d = new Date(r.nextAt!);
    expect(d.getDate()).toBe(26);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
  });
});

describe("nextRunAt — cron", () => {
  it("respects cron expression", () => {
    // every 10 min, 9-15h, Mon-Fri
    const r = nextRunAt(
      { cron: "0/10 9-15 * * 1-5" },
      new Date(2026, 4, 25, 9, 5, 0).getTime(),
    );
    const d = new Date(r.nextAt!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(10);
  });
});

describe("nextRunAt — skip conditions", () => {
  it("skips weekend with onWeekdays", () => {
    // Saturday 2026-05-30 09:00
    const sat = new Date(2026, 4, 30, 9, 0, 0).getTime();
    const r = nextRunAt(
      { intervalMs: 60_000, onWeekdays: [1, 2, 3, 4, 5] },
      sat,
    );
    // 다음 월요일 09:00 이후로 밀려야 함
    const d = new Date(r.nextAt!);
    expect([1, 2, 3, 4, 5]).toContain(d.getDay());
  });

  it("skips time range", () => {
    // 02:00 시각, intervalMs 1분, skip 00:00-07:00
    const earlyMorning = new Date(2026, 4, 25, 2, 0, 0).getTime();
    const r = nextRunAt(
      { intervalMs: 60_000, skipTimeRanges: ["00:00-07:00"] },
      earlyMorning,
    );
    const d = new Date(r.nextAt!);
    expect(d.getHours()).toBeGreaterThanOrEqual(7);
  });

  it("skips specific date", () => {
    const before = new Date(2026, 4, 25, 9, 0, 0).getTime();
    const r = nextRunAt(
      { atTimes: ["09:30"], skipDates: ["2026-05-25", "2026-05-26"] },
      before,
    );
    const d = new Date(r.nextAt!);
    expect(d.getDate()).toBeGreaterThanOrEqual(27);
  });
});

describe("isSkipped", () => {
  it("returns null when no skip conditions", () => {
    expect(isSkipped(MON_0900, {})).toBeNull();
  });

  it("returns reason for weekday block", () => {
    expect(isSkipped(MON_0900, { onWeekdays: [0, 6] })).toMatch(/weekday/);
  });

  it("returns reason for time range block", () => {
    // 03:00
    const t = new Date(2026, 4, 25, 3, 0, 0).getTime();
    expect(isSkipped(t, { skipTimeRanges: ["00:00-07:00"] })).toMatch(/skip range/);
  });

  it("returns reason for date block", () => {
    expect(isSkipped(MON_0900, { skipDates: ["2026-05-25"] })).toMatch(
      /in skipDates/,
    );
  });
});
