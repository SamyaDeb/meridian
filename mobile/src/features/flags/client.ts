// Reads `${webUrl}/api/flags` on start, on every foreground and every 60 s while the app is active (no polling in the
// background), keeps the last good value in the app's KV (non-secret) with its read time, and publishes the policy's
// view (model.ts resolveFlags). webUrl undefined (production until N9) ⇒ every read is "unknown", like unreachable.
import type { FetchLike } from "@meridian/core/util";
import type { KV } from "../../auth/credentialStore";
import type { AppEnv } from "../../config/appConfig";
import { Store } from "../../live/store";
import { INITIAL_VIEW, parseFlags, POLL_MS, resolveFlags, type Flags, type FlagsView, type LastGood } from "./model";

/** The React Native AppState subset this uses (a fake in tests). */
export type AppStateLike = {
  currentState: string;
  addEventListener(type: "change", fn: (s: string) => void): { remove(): void };
};

export type FlagsClientOpts = {
  webUrl: string | undefined;
  env: AppEnv;
  appVersion: string | undefined;
  fetch: FetchLike;
  kv: KV;
  appState: AppStateLike;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
};

const TIMEOUT_MS = 8_000;

export const flagsKey = (env: AppEnv): string => `meridian.flags.v1.${env}`;

function parseLast(raw: string | null): LastGood | undefined {
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw) as { flags?: unknown; atMs?: unknown };
    const flags = parseFlags(j.flags);
    return flags && typeof j.atMs === "number" && Number.isFinite(j.atMs) ? { flags, atMs: j.atMs } : undefined;
  } catch {
    return undefined;
  }
}

export class FlagsClient {
  readonly store = new Store<FlagsView>(INITIAL_VIEW);
  private last: LastGood | undefined;
  private loaded = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(private readonly o: FlagsClientOpts) {
    this.now = o.now ?? Date.now;
  }

  /** The URL read, or undefined when this env has no web app yet. */
  get url(): string | undefined {
    return this.o.webUrl ? `${this.o.webUrl.replace(/\/$/, "")}/api/flags` : undefined;
  }

  private publish(live: Flags | undefined): void {
    this.store.set(resolveFlags({ live, last: this.last, nowMs: this.now(), env: this.o.env, appVersion: this.o.appVersion }));
  }

  private async read(): Promise<Flags | undefined> {
    const url = this.url;
    if (!url) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), this.o.timeoutMs ?? TIMEOUT_MS)));
      const req = this.o.fetch(url, { method: "GET", headers: { accept: "application/json" } }).then(async (r) => (r.status === 200 ? parseFlags(JSON.parse(await r.text())) : undefined));
      return await Promise.race([req, timeout]);
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** One read; concurrent calls share it. Never throws. */
  refresh(): Promise<void> {
    this.inflight ??= (async () => {
      try {
        if (!this.loaded) {
          this.loaded = true;
          this.last = parseLast(await this.o.kv.get(flagsKey(this.o.env)).catch(() => null));
        }
        const live = await this.read();
        if (live) {
          this.last = { flags: live, atMs: this.now() };
          await this.o.kv.set(flagsKey(this.o.env), JSON.stringify(this.last)).catch(() => undefined);
        }
        this.publish(live);
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  get polling(): boolean {
    return this.timer !== undefined;
  }

  private startPoll(): void {
    if (this.timer === undefined) this.timer = setInterval(() => void this.refresh(), this.o.pollMs ?? POLL_MS);
  }

  private stopPoll(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Read now, on every foreground, and every 60 s while active. Returns the stop function. */
  start(): () => void {
    void this.refresh();
    // RN can report "unknown" before the first change event: only a known background state skips the poll
    if (this.o.appState.currentState !== "background") this.startPoll();
    const sub = this.o.appState.addEventListener("change", (s) => {
      if (s === "active") {
        void this.refresh();
        this.startPoll();
      } else if (s === "background") this.stopPoll();
    });
    return () => {
      sub.remove();
      this.stopPoll();
    };
  }
}
