// jest-expo (docs.expo.dev/develop/unit-testing). Under pnpm every package lives in node_modules/.pnpm, so `.pnpm` is
// in the allow-list (the doc's pnpm pattern) and ESM deps (viem, noble, scure) get transformed too. No device needed.
const path = require("path");

// One copy of React and the RN UI-thread stack in tests. react-native-gesture-handler imports react-native-reanimated
// without declaring it, so Jest finds it through pnpm's hidden hoist (node_modules/.pnpm/node_modules), which on some
// installs is the web app's Reanimated built against React 19.2.8 → "Cannot read properties of null (reading
// 'useState')". Metro already bundles a single copy (checked from the export's source map); this pins Jest the same way.
const SINGLETONS = ["react", "react-native", "react-native-reanimated", "react-native-worklets", "react-native-gesture-handler"];
const pinned = Object.fromEntries(
  SINGLETONS.flatMap((p) => {
    const dir = path.dirname(require.resolve(`${p}/package.json`, { paths: [__dirname] }));
    return [
      [`^${p}$`, dir],
      [`^${p}/(.*)$`, `${dir}/$1`],
    ];
  }),
);

/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo",
  moduleNameMapper: pinned,
  // react-native-worklets ships this resolver so jest loads its JS (not .native) implementation
  resolver: require.resolve("react-native-worklets/jest/resolver.js"),
  setupFiles: ["./jest.setup.js"],
  setupFilesAfterEnv: ["./jest.after-env.js"],
  // a cold run transforms viem / Mera / RN for the first time; the 5 s default timed out suites on fresh CI caches
  testTimeout: 30_000,
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts?(x)"],
  transformIgnorePatterns: [
    "node_modules/(?!(.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg|@gorhom/.*|viem|ox|abitype|@noble/.*|@scure/.*|@meridian/.*|@category-labs/.*|react-native-qrcode-svg))",
  ],
};
