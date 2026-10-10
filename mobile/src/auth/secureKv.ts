// SecureStore-backed KV for the credential record (Android Keystore-encrypted). Non-secret data only.
import * as SecureStore from "expo-secure-store";
import type { KV } from "./credentialStore";

export const secureKv: KV = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  del: (k) => SecureStore.deleteItemAsync(k),
};
