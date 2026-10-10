import { describe, expect, it } from "vitest";
import hedge from "./fixtures/account-10143-k3-hedge.json";
import main1076 from "./fixtures/account-143-1076.json";
import none from "./fixtures/account-10143-none.json";
import mkt10143 from "./fixtures/market-10143.json";
import mkt143 from "./fixtures/market-143.json";
import { perpsFromBanks, readPerplAccount, readPerplMarket, serverRpcUrl, PerplReadError, type PerplReader } from "./perplChain";
import { handleMarket, handlePositions, parseChain } from "./perplRoutes";
import { replayReader, type Recording } from "./recordedReader";

const rec = (r: unknown) => r as Recording & { expected: unknown };
const u = (q: string, path = "positions") => new URL(`http://x/api/perpl/${path}?${q}`);

describe("readPerplAccount on recorded chain reads", () => {
  it("K3 hedge account on testnet: account 969, one MON long of 2,600 lots, maintenance 500 hdths", async () => {
    const out = await readPerplAccount(replayReader(rec(hedge)), 10143, "0xfc76fe796f22665f0a48863ff5d7a03a4fcd7775");
    expect(out).toEqual(rec(hedge).expected);
    expect(out.address).toBe("0xFC76FE796f22665f0A48863Ff5d7a03A4FcD7775"); // EIP-55
    expect(out.account?.accountId).toBe("969");
    expect(out.positions.map((p) => [p.perpId, p.positionType, p.lotLNS, p.maintMarginHdths])).toEqual([[64, 0, "2600", "500"]]);
  });
  it("public mainnet account 1076: MON long 19,823 lots, maintenance 2000 hdths (5 %)", async () => {
    const out = await readPerplAccount(replayReader(rec(main1076)), 143, "0xf27732351024f7D9a9da128311e13bFa183bde8e");
    expect(out).toEqual(rec(main1076).expected);
    expect(out.positions[0]).toMatchObject({ perpId: 10, lotLNS: "19823", maintMarginHdths: "2000", priceDecimals: 6 });
  });
  it("an address with no Perpl account is 'no account', not an error", async () => {
    const out = await readPerplAccount(replayReader(rec(none)), 10143, "0x000000000000000000000000000000000000dEaD");
    expect(out.account).toBeNull();
    expect(out.positions).toEqual([]);
  });
  it("markets: rate in force, last funding block, fees and margins per chain", async () => {
    expect(await readPerplMarket(replayReader(rec(mkt10143)), 10143)).toEqual(rec(mkt10143).expected);
    expect(await readPerplMarket(replayReader(rec(mkt143)), 143)).toEqual(rec(mkt143).expected);
  });
  it("refuses a non-address", async () => {
    await expect(readPerplAccount(replayReader(rec(none)), 10143, "0x123")).rejects.toThrow(RangeError);
  });
});

describe("routes", () => {
  it("200 with the account payload; cached for 5 s (a second request makes no reads)", async () => {
    let made = 0;
    const r1 = replayReader(rec(hedge));
    const counting = { getBlockNumber: () => (made++, r1.getBlockNumber()), multicall: (a: Parameters<PerplReader["multicall"]>[0]) => (made++, r1.multicall(a)) } as PerplReader;
    const res = await handlePositions(u("address=0xFC76FE796f22665f0A48863Ff5d7a03A4FcD7775&chain=10143"), { reader: () => counting });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { accountId: string }; stale: boolean };
    expect(body.account.accountId).toBe("969");
    expect(body.stale).toBe(false);
    const n = made;
    const again = await handlePositions(u("address=0xFC76FE796f22665f0A48863Ff5d7a03A4FcD7775&chain=10143"), { reader: () => counting });
    expect(again.status).toBe(200);
    expect(made).toBe(n);
  });
  it("400 on a bad address or chain, 503 naming the missing RPC env", async () => {
    expect((await handlePositions(u("address=nope&chain=10143"))).status).toBe(400);
    expect((await handlePositions(u("address=0x000000000000000000000000000000000000dEaD&chain=1"))).status).toBe(400);
    const r = await handlePositions(u("address=0x000000000000000000000000000000000000dEaD&chain=143"), { reader: () => undefined });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe("Monad mainnet RPC not configured (MONAD_RPC_URL)");
  });
  it("RPC down ⇒ 502 with our own message (never the RPC URL); 429 ⇒ 503 rate-limited with a retry hint", async () => {
    const down = { getBlockNumber: async () => { throw new Error("fetch failed https://secret.example/key"); } } as unknown as PerplReader;
    const r = await handlePositions(u("address=0x1111111111111111111111111111111111111111&chain=10143"), { reader: () => down });
    expect(r.status).toBe(502);
    const body = JSON.stringify(await r.json());
    expect(body).toContain("Monad testnet RPC unreachable");
    expect(body).not.toContain("secret");
    const limited = { getBlockNumber: async () => { throw Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 }); } } as unknown as PerplReader;
    const r2 = await handlePositions(u("address=0x2222222222222222222222222222222222222222&chain=10143"), { reader: () => limited });
    expect(r2.status).toBe(503);
    expect(await r2.json()).toMatchObject({ rpc: "rate-limited" });
  });
  it("market route", async () => {
    const r = await handleMarket(u("chain=143", "market"), { reader: () => replayReader(rec(mkt143)) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ perpId: 10, fundingRatePct100k: "3" });
    expect(parseChain(null)).toBe(10143);
    expect(parseChain("5")).toBeUndefined();
  });
});

describe("pure helpers", () => {
  it("position banks → perp ids (bank1 = 2^64 ⇔ perp 64; bank2 bit 0 ⇔ perp 256)", () => {
    expect(perpsFromBanks([2n ** 64n, 0n, 0n, 0n])).toEqual([64]);
    expect(perpsFromBanks([2n ** 10n + 2n ** 16n, 1n, 0n, 2n ** 255n])).toEqual([10, 16, 256, 1023]);
    expect(perpsFromBanks([0n, 0n, 0n, 0n])).toEqual([]);
  });
  it("server RPC from env: server-only name first, then the public read RPC; nothing hard-coded", () => {
    expect(serverRpcUrl(143, { MONAD_RPC_URL: "a", NEXT_PUBLIC_MONAD_RPC_URL: "b" })).toBe("a");
    expect(serverRpcUrl(10143, { NEXT_PUBLIC_MONAD_TESTNET_RPC_URL: "c" })).toBe("c");
    expect(serverRpcUrl(10143, {})).toBeUndefined();
  });
  it("PerplReadError is exported for the route's own messages", () => expect(new PerplReadError("x")).toBeInstanceOf(Error));
});
