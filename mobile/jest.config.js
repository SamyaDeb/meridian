// jest-expo (docs.expo.dev/develop/unit-testing). Under pnpm every package lives in node_modules/.pnpm, so `.pnpm` is
// in the allow-list (the doc's pnpm pattern) and ESM deps (viem, noble, scure) get transformed too. No device needed.
/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo",
  // react-native-worklets ships this resolver so jest loads its JS (not .native) implementation
  resolver: require.resolve("react-native-worklets/jest/resolver.js"),
  setupFiles: ["./jest.setup.js"],
  setupFilesAfterEnv: ["./jest.after-env.js"],
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts?(x)"],
  transformIgnorePatterns: [
    "node_modules/(?!(.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg|@gorhom/.*|viem|ox|abitype|@noble/.*|@scure/.*|@meridian/.*))",
  ],
};
