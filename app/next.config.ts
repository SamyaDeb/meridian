import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Android Digital Asset Links for the native app's passkeys (MOBILE_PLAN N3): must be served as JSON, no redirect.
  async headers() {
    return [{ source: "/.well-known/assetlinks.json", headers: [{ key: "Content-Type", value: "application/json" }] }];
  },
  // @meridian/risk ships TypeScript source (shared with keepers/alerts): Next compiles it like app code
  transpilePackages: ["@meridian/risk"],
};

export default nextConfig;
