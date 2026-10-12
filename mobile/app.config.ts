// Expo app config per build profile. APP_ENV (eas.json profile env, or the shell for `expo start`) picks the identity;
// everything here is non-secret. RPC URLs are EXPO_PUBLIC_* env vars (mobile/.env.local, EAS env), read at runtime by
// src/config, never copied into `extra`. No ios.associatedDomains: no Apple team (MOBILE_PLAN §5, 8 Oct).
import type { ConfigContext, ExpoConfig } from "expo/config";

type AppEnv = "development" | "staging" | "production";

const ENVS: readonly AppEnv[] = ["development", "staging", "production"];
const raw = process.env.APP_ENV ?? "development";
if (!(ENVS as readonly string[]).includes(raw)) throw new Error(`APP_ENV must be one of ${ENVS.join(", ")}; got "${raw}"`);
const appEnv = raw as AppEnv;

// Only development falls back to the public RPC (src/config/appConfig.ts); a staging/production build without
// EXPO_PUBLIC_MONAD_RPC_URL has no chain reads at all (L2 preview 2242d587: balances never loaded). Fail the EAS build
// instead of shipping that. EAS_BUILD is set on EAS builders only, so local tooling and tests are unaffected.
if (process.env.EAS_BUILD === "true" && appEnv !== "development" && !process.env.EXPO_PUBLIC_MONAD_RPC_URL?.trim()) {
  throw new Error(`EXPO_PUBLIC_MONAD_RPC_URL is not set for the ${appEnv} build: add it to the EAS environment (eas env:create)`);
}

// MOBILE_PLAN §5 (N0, 8 Oct): two Android packages, both in assetlinks. Staging installs next to production. The dev
// client reuses the staging package (testnet, staging rpId) so N3 passkeys work in it without a third assetlinks entry;
// a dev build and a preview build therefore replace each other on one phone.
const IDENTITY: Record<AppEnv, { name: string; androidPackage: string; scheme: string }> = {
  development: { name: "Meridian Dev", androidPackage: "xyz.meridianfi.app.staging", scheme: "meridian-dev" },
  staging: { name: "Meridian Staging", androidPackage: "xyz.meridianfi.app.staging", scheme: "meridian-staging" },
  production: { name: "Meridian", androidPackage: "xyz.meridianfi.app", scheme: "meridian" },
};

// Splash + adaptive icon background = the first screen's background (src/ui/tokens.ts colors.bg).
const BG = "#050507";

export default ({ config }: ConfigContext): ExpoConfig => {
  const id = IDENTITY[appEnv];
  return {
    ...config,
    name: id.name,
    slug: "meridian",
    // N8: the first preview build (owner confirms the numbers in the N8-prep PR). Bump both for every build that
    // ships, and set FLAGS_MIN_APP_VERSION on Vercel at or below this version.
    version: "0.2.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: id.scheme,
    userInterfaceStyle: "dark",
    backgroundColor: BG,
    android: {
      package: id.androidPackage,
      versionCode: 2,
      adaptiveIcon: {
        backgroundColor: BG,
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
    },
    plugins: [
      "expo-router",
      ["expo-splash-screen", { backgroundColor: BG, image: "./assets/images/splash-icon.png", imageWidth: 96 }],
    ],
    experiments: { typedRoutes: true, reactCompiler: true },
    // EAS project @samyadeb/meridian (eas init, 8 Oct 2026)
    owner: "samyadeb",
    extra: {
      ...(config.extra ?? {}),
      appEnv,
      eas: { projectId: "802495fa-47fc-4211-95e7-6753d89074c2" },
    },
  };
};
