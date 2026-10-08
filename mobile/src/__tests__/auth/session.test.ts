import { backgroundExpired, BACKGROUND_LOCK_MS, IDLE_LOCK_MS, idleExpired, INITIAL, reduce, type AuthState } from "../../auth/session";

const A = "0x50B240678777451BEfd67B7e8c3b4366482ba8F9" as const;
const locked = (hasAccount: boolean): AuthState => ({ status: "locked", hasAccount, addressHint: hasAccount ? A : undefined, reason: "start" });

describe("auth state machine", () => {
  it("loading → locked with or without an account", () => {
    expect(reduce(INITIAL, { type: "LOADED", addressHint: undefined })).toEqual(locked(false));
    expect(reduce(INITIAL, { type: "LOADED", addressHint: A })).toEqual(locked(true));
  });
  it("locked → unlocking(passkey) → unlocking(deriving) → unlocked → locked(reason)", () => {
    let s = reduce(locked(true), { type: "UNLOCK_START" });
    expect(s).toEqual({ status: "unlocking", hasAccount: true, addressHint: A, step: "passkey" });
    s = reduce(s, { type: "DERIVING" });
    expect(s).toMatchObject({ status: "unlocking", step: "deriving" });
    s = reduce(s, { type: "UNLOCK_OK", address: A });
    expect(s).toEqual({ status: "unlocked", address: A });
    for (const reason of ["idle", "background", "manual"] as const) expect(reduce(s, { type: "LOCK", reason })).toEqual({ status: "locked", hasAccount: true, addressHint: A, reason });
  });
  it("a failed unlock goes back to locked(failed) keeping the account hint", () => {
    const s = reduce(reduce(locked(true), { type: "UNLOCK_START" }), { type: "UNLOCK_FAIL" });
    expect(s).toEqual({ status: "locked", hasAccount: true, addressHint: A, reason: "failed" });
  });
  it("sign-out forgets the account from any loaded state", () => {
    const out = { status: "locked", hasAccount: false, addressHint: undefined, reason: "signout" };
    expect(reduce({ status: "unlocked", address: A }, { type: "SIGNED_OUT" })).toEqual(out);
    expect(reduce(locked(true), { type: "SIGNED_OUT" })).toEqual(out);
    expect(reduce(INITIAL, { type: "SIGNED_OUT" })).toBe(INITIAL);
  });
  it("ignores invalid transitions (same reference)", () => {
    const u: AuthState = { status: "unlocked", address: A };
    const l = locked(true);
    expect(reduce(u, { type: "UNLOCK_START" })).toBe(u);
    expect(reduce(l, { type: "UNLOCK_OK", address: A })).toBe(l);
    expect(reduce(l, { type: "LOCK", reason: "idle" })).toBe(l);
    expect(reduce(l, { type: "DERIVING" })).toBe(l);
    expect(reduce(u, { type: "LOADED", addressHint: A })).toBe(u);
    const d = reduce(reduce(l, { type: "UNLOCK_START" }), { type: "DERIVING" });
    expect(reduce(d, { type: "DERIVING" })).toBe(d);
  });
  it("timer predicates: idle at ≥ 10 min, background strictly > 5 min", () => {
    expect(IDLE_LOCK_MS).toBe(600_000);
    expect(BACKGROUND_LOCK_MS).toBe(300_000);
    expect(idleExpired(0, IDLE_LOCK_MS - 1, IDLE_LOCK_MS)).toBe(false);
    expect(idleExpired(0, IDLE_LOCK_MS, IDLE_LOCK_MS)).toBe(true);
    expect(backgroundExpired(undefined, 10 ** 12, BACKGROUND_LOCK_MS)).toBe(false);
    expect(backgroundExpired(0, BACKGROUND_LOCK_MS, BACKGROUND_LOCK_MS)).toBe(false);
    expect(backgroundExpired(0, BACKGROUND_LOCK_MS + 1, BACKGROUND_LOCK_MS)).toBe(true);
  });
});
