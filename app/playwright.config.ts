import { defineConfig } from "@playwright/test";

// Smoke against a running app in chain mode on anvil (see e2e/README note in the spec). Not part of `pnpm test`.
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  use: { baseURL: process.env.APP_URL ?? "http://localhost:3117", viewport: { width: 390, height: 844 } },
  reporter: "list",
});
