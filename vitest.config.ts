import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["backend/src/**/*.test.ts"],
    exclude: ["backend/dist/**", "node_modules/**"],
    // Integration suites share the repository SQLite/Milvus test doubles; run
    // files serially so one suite cannot replace another suite's snapshot.
    fileParallelism: false,
  },
})
