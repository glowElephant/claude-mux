import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 60_000,
    // PTY 인터랙티브는 사람 속도. 파일 간 병렬 실행 비활성화 — 동시 spawn 충돌 방지.
    fileParallelism: false,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
});
