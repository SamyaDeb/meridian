import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/flags/route";
import { DEFAULT_FLAGS, FLAG_ENV, fetchFlags, gateDecision, parseFlags, readFlagsEnv } from "./flags";

const quiet = () => undefined;

describe("readFlagsEnv", () => {
  it("defaults: everything on, minAppVersion 0.0.0, no message", () => {
    expect(readFlagsEnv({}, quiet)).toEqual({ v: 1, writes: true, perpl: true, earn: true, lock: true, minAppVersion: "0.0.0" });
    expect(readFlagsEnv({}, quiet)).toEqual(DEFAULT_FLAGS);
  });

  it.each(["writes", "perpl", "earn", "lock"] as const)("%s follows its env flag both ways", (k) => {
    expect(readFlagsEnv({ [FLAG_ENV[k]]: "false" }, quiet)[k]).toBe(false);
    expect(readFlagsEnv({ [FLAG_ENV[k]]: "true" }, quiet)[k]).toBe(true);
    // only that one changes
    const off = readFlagsEnv({ [FLAG_ENV[k]]: "false" }, quiet);
    for (const o of ["writes", "perpl", "earn", "lock"] as const) if (o !== k) expect(off[o]).toBe(true);
  });

  it("minAppVersion and message come from env", () => {
    const f = readFlagsEnv({ FLAGS_MIN_APP_VERSION: "0.3.0", FLAGS_MESSAGE: "  Back at 14:00 UTC  " }, quiet);
    expect(f.minAppVersion).toBe("0.3.0");
    expect(f.message).toBe("Back at 14:00 UTC");
  });

  it("bad values fall back to the default with a warning, never throw", () => {
    const warn = vi.fn();
    const f = readFlagsEnv({ FLAGS_WRITES: "False", FLAGS_PERPL: "0", FLAGS_EARN: "no", FLAGS_LOCK: "yes", FLAGS_MIN_APP_VERSION: "v1" }, warn);
    expect(f).toEqual(DEFAULT_FLAGS);
    expect(warn).toHaveBeenCalledTimes(5);
    expect(warn.mock.calls[0]![0]).toContain("FLAGS_WRITES");
  });

  it("an empty string counts as unset (no warning)", () => {
    const warn = vi.fn();
    expect(readFlagsEnv({ FLAGS_WRITES: "", FLAGS_MESSAGE: "   " }, warn)).toEqual(DEFAULT_FLAGS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("caps the message length", () => {
    expect(readFlagsEnv({ FLAGS_MESSAGE: "x".repeat(500) }, quiet).message).toHaveLength(200);
  });
});

describe("GET /api/flags", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the env flags with edge cache + CORS headers", async () => {
    vi.stubEnv("FLAGS_WRITES", "false");
    vi.stubEnv("FLAGS_MESSAGE", "Upgrading the keeper");
    const r = GET();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=30, stale-while-revalidate=30");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-methods")).toBe("GET");
    const body = await r.json();
    expect(body).toEqual({ ...DEFAULT_FLAGS, writes: false, message: "Upgrading the keeper" });
    expect(parseFlags(body)).toEqual(body);
  });

  it("never throws on a bad env value", async () => {
    vi.stubEnv("FLAGS_WRITES", "maybe");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = await GET().json();
    expect(body.writes).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("parseFlags", () => {
  it("accepts the route's shape and rejects anything else", () => {
    expect(parseFlags(DEFAULT_FLAGS)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags(null)).toBeUndefined();
    expect(parseFlags({ ...DEFAULT_FLAGS, v: 2 })).toBeUndefined();
    expect(parseFlags({ ...DEFAULT_FLAGS, writes: "false" })).toBeUndefined();
    expect(parseFlags({ ...DEFAULT_FLAGS, minAppVersion: "1.0" })).toBeUndefined();
  });
});

describe("gateDecision (web WriteGate)", () => {
  const off = { ...DEFAULT_FLAGS, writes: false };
  it("refuses an open when writes is off", () => {
    expect(gateDecision({ geoRestricted: false, opens: true, flags: off, termsAccepted: true })).toBe("paused");
  });
  it("never blocks a close / cancel / withdraw", () => {
    expect(gateDecision({ geoRestricted: false, opens: false, flags: off, termsAccepted: true })).toBe("ok");
  });
  it("unreachable flags allow; terms and geo still apply", () => {
    expect(gateDecision({ geoRestricted: false, opens: true, flags: undefined, termsAccepted: true })).toBe("ok");
    expect(gateDecision({ geoRestricted: false, opens: true, flags: DEFAULT_FLAGS, termsAccepted: false })).toBe("terms");
    expect(gateDecision({ geoRestricted: true, opens: false, flags: DEFAULT_FLAGS, termsAccepted: true })).toBe("restricted");
  });
});

describe("fetchFlags", () => {
  it("parses a good response; any failure is undefined", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(DEFAULT_FLAGS), { status: 200 }));
    expect(await fetchFlags(ok as unknown as typeof fetch)).toEqual(DEFAULT_FLAGS);
    expect(ok).toHaveBeenCalledWith("/api/flags", { cache: "no-store" });
    expect(await fetchFlags((async () => new Response("x", { status: 500 })) as unknown as typeof fetch)).toBeUndefined();
    expect(await fetchFlags((async () => new Response("not json", { status: 200 })) as unknown as typeof fetch)).toBeUndefined();
    expect(
      await fetchFlags((async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch),
    ).toBeUndefined();
  });
});
