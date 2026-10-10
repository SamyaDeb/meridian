// N8 D4.6: the first preview build's version (0.2.0 / versionCode 2 — owner confirms in the PR) and what Settings →
// Version shows: the version from expo-constants (the forced-update compare uses the same), the profile and the chain.
jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { version: "0.2.0", extra: { appEnv: "staging" } } } }));

import { appVersion, buildInfo } from "../config";
import { versionBelow } from "../features/flags/model";

type AppConfigFn = (ctx: { config: Record<string, unknown> }) => { version?: string; android?: { versionCode?: number; package?: string } };

it("app.config.ts: version 0.2.0, Android versionCode 2, on every profile", () => {
  for (const env of ["development", "staging", "production"]) {
    process.env.APP_ENV = env;
    let fn!: AppConfigFn;
    jest.isolateModules(() => {
      fn = (require("../../app.config") as { default: AppConfigFn }).default;
    });
    const c = fn({ config: {} });
    expect(c.version).toBe("0.2.0");
    expect(c.android?.versionCode).toBe(2);
  }
  delete process.env.APP_ENV;
});

it("Settings → Version: version · profile · chain; the forced-update compare reads the same version", () => {
  expect(appVersion()).toBe("0.2.0");
  expect(buildInfo()).toEqual({ version: "0.2.0", env: "staging", chainId: 10143 });
  expect(versionBelow(appVersion(), "0.2.0")).toBe(false);
  expect(versionBelow(appVersion(), "0.2.1")).toBe(true);
});
