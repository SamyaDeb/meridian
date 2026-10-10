// A FlagsClient on fakes (no network): `set()` changes what /api/flags answers, `fail()` makes it unreachable, `state()`
// moves the fake AppState. Used by the flags unit tests and the screen tests that flip a kill switch.
import type { FetchLike } from "@meridian/core/util";
import type { AppEnv } from "../../config/appConfig";
import { FlagsClient, type AppStateLike } from "../../features/flags/client";
import { DEFAULT_FLAGS, type Flags } from "../../features/flags/model";

export function memKv() {
  const map = new Map<string, string>();
  return { map, kv: { get: async (k: string) => map.get(k) ?? null, set: async (k: string, v: string) => void map.set(k, v), del: async (k: string) => void map.delete(k) } };
}

export function fakeAppState(initial = "active") {
  const fns = new Set<(s: string) => void>();
  const app: AppStateLike & { set(s: string): void; listeners: () => number } = {
    currentState: initial,
    addEventListener: (_t, fn) => (fns.add(fn), { remove: () => void fns.delete(fn) }),
    set(s) {
      app.currentState = s;
      for (const f of [...fns]) f(s);
    },
    listeners: () => fns.size,
  };
  return app;
}

export function fakeFlags(o: { flags?: Partial<Flags>; env?: AppEnv; webUrl?: string | undefined; appVersion?: string; now?: () => number; kv?: ReturnType<typeof memKv> } = {}) {
  let body: unknown = { ...DEFAULT_FLAGS, ...o.flags };
  let down = false;
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    if (down) throw new Error("Network request failed");
    return { status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
  };
  const kv = o.kv ?? memKv();
  const appState = fakeAppState();
  const client = new FlagsClient({ webUrl: "webUrl" in o ? o.webUrl : "https://meridian-testnet.vercel.app", env: o.env ?? "staging", appVersion: o.appVersion ?? "0.2.0", fetch, kv: kv.kv, appState, ...(o.now ? { now: o.now } : {}) });
  return {
    client,
    kv,
    appState,
    calls,
    set: (f: Partial<Flags>) => {
      body = { ...DEFAULT_FLAGS, ...f };
      down = false;
    },
    raw: (b: unknown) => {
      body = b;
    },
    fail: () => {
      down = true;
    },
  };
}
