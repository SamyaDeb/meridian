import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Android Digital Asset Links for the native app's passkeys (MOBILE_PLAN N3): must be served as JSON, no redirect.
  async headers() {
    return [{ source: "/.well-known/assetlinks.json", headers: [{ key: "Content-Type", value: "application/json" }] }];
  },
  // @meridian/risk and @meridian/core ship TypeScript source (shared with keepers/alerts/mobile): Next compiles them like app code
  transpilePackages: ["@meridian/risk", "@meridian/core"],
};

export default nextConfig;
