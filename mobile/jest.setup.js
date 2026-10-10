require("react-native-gesture-handler/jestSetup");
jest.mock("@react-native-community/netinfo", () => require("@react-native-community/netinfo/jest/netinfo-mock.js"));
// react-native-passkey reaches a TurboModule at import; tests use the fake WebAuthn client (src/auth/fakeWebAuthn.ts)
jest.mock("react-native-passkey", () => ({ Passkey: { createPlatformKey: jest.fn(), getPlatformKey: jest.fn(), isSupported: () => false } }));
// native Expo modules N3 uses, in memory (storageScan.test.ts installs its own recording SecureStore)
jest.mock("expo-secure-store", () => {
  const m = new Map();
  return { getItemAsync: async (k) => m.get(k) ?? null, setItemAsync: async (k, v) => void m.set(k, v), deleteItemAsync: async (k) => void m.delete(k) };
});
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock("expo-screen-capture", () => ({ usePreventScreenCapture: jest.fn() }));
