// N8 D4.4: the compile-time env the release guard relies on. EXPO_PUBLIC_APP_ENV (inlined by Metro) folds the testnet
// web URL out of production bundles; every EAS profile sets it equal to APP_ENV. The bundle itself is checked by
// `pnpm --filter @meridian/mobile check:release` (preview + production exports, source-map-attributed URL scan).
import meridian10143 from "../../../deployments/10143.json";
import perplJson from "../../../deployments/perpl.json";
import type * as AppConfigModule from "../config/appConfig";
import { fs, path, SRC_DIR } from "./node";

const input = (appEnv: string) => ({ appEnv, rpcUrl: undefined, wsUrl: undefined, meridianDeployments: { 10143: meridian10143 }, perplJson });

function load(bundleEnv: string | undefined): typeof AppConfigModule {
  const prev = process.env.EXPO_PUBLIC_APP_ENV;
  if (bundleEnv === undefined) delete process.env.EXPO_PUBLIC_APP_ENV;
  else process.env.EXPO_PUBLIC_APP_ENV = bundleEnv;
  let mod!: typeof AppConfigModule;
  jest.isolateModules(() => {
    mod = require("../config/appConfig") as typeof AppConfigModule;
  });
  if (prev === undefined) delete process.env.EXPO_PUBLIC_APP_ENV;
  else process.env.EXPO_PUBLIC_APP_ENV = prev;
  return mod;
}

it("a production bundle has no testnet web URL; staging / development keep the testnet terminal", () => {
  const prod = load("production");
  expect(prod.buildAppConfig(input("production")).webUrl).toBeUndefined();
  expect(load("staging").buildAppConfig(input("staging")).webUrl).toBe("https://meridian-testnet.vercel.app");
  expect(load(undefined).buildAppConfig(input("development")).webUrl).toBe("https://meridian-testnet.vercel.app");
});

it("every EAS profile sets EXPO_PUBLIC_APP_ENV equal to APP_ENV", () => {
  const eas = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "..", "eas.json"), "utf8")) as { build: Record<string, { env: Record<string, string> }> };
  expect(Object.keys(eas.build).sort()).toEqual(["development", "preview", "production"]);
  for (const p of Object.values(eas.build)) expect(p.env.EXPO_PUBLIC_APP_ENV).toBe(p.env.APP_ENV);
  expect(eas.build.production!.env.APP_ENV).toBe("production");
});

it("check:release exports preview AND production, with a clean cache, and scans for local + testnet URLs", () => {
  const s = fs.readFileSync(path.join(SRC_DIR, "..", "scripts", "check-release.mjs"), "utf8");
  expect(s).toMatch(/for \(const profile of \["preview", "production"\]\) check\(profile\);/);
  expect(s).toContain('"--clear"');
  expect(s).toContain("localhost|127\\.0\\.0\\.1|10\\.0\\.2\\.2");
  expect(s).toContain("https:\\/\\/meridian-testnet\\.vercel\\.app");
  for (const m of ["meridian-fake-webauthn-client", "devFakeWebAuthnClient", "createFakeWebAuthnClient", "meridian-dev-force-meridian-fail"]) expect(s).toContain(`"${m}"`);
});
