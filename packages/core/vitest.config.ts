import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // no network in tests: everything replays recorded fixtures (packages/core/fixtures)
    testTimeout: 20_000,
  },
});
