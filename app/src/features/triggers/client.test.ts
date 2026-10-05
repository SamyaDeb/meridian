import { describe, expect, it } from "vitest";
import type { PublicClient, WalletClient } from "viem";
import { mockTriggerClient, triggerMode } from "./client";

const wallet = (a: string) => ({ account: { address: a } }) as unknown as WalletClient;
const pub = {} as PublicClient;
const P = { kind: "StopMarket" as const, isBid: false, lots: 1n, triggerPriceWad: 1n, limitTick: 1, expiryBlock: 10n };

describe("trigger feature flag", () => {
  it("off without a manager or the mock flag; mock only with the flag (31337 has no manager)", () => {
    expect(triggerMode(31337, undefined)).toBe("off");
    expect(triggerMode(31337, "0")).toBe("off");
    expect(triggerMode(31337, "1")).toBe("mock");
    expect(triggerMode(143, undefined)).toBe("off");
    expect(triggerMode(143, "1")).toBe("off"); // D9: never the mock on mainnet
  });
});

describe("mock trigger client", () => {
  it("creates, lists per account, cancels; returns block 0 (nothing sent)", async () => {
    const c = mockTriggerClient();
    const r = await c.create(pub, wallet("0xAA"), P);
    expect(r.block).toBe(0n);
    await c.create(pub, wallet("0xAA"), { ...P, kind: "TakeProfitMarket" });
    expect((await c.list("0xaa")).map((t) => t.kind)).toEqual(["StopMarket", "TakeProfitMarket"]);
    expect(await c.list("0xbb")).toEqual([]);
    const [first] = await c.list("0xaa");
    await c.cancel(pub, wallet("0xAA"), first!.id);
    expect(await c.list("0xaa")).toHaveLength(1);
  });
  it("enforces 8 per account like CR-012's MAX_TRIGGERS_PER_ACCOUNT", async () => {
    const c = mockTriggerClient();
    for (let i = 0; i < 8; i++) await c.create(pub, wallet("0xCC"), P);
    await expect(c.create(pub, wallet("0xCC"), P)).rejects.toThrow(/TooManyTriggers/);
  });
});
