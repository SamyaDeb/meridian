import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { A, ALICE, BOB, CHAIN, blk } from "./helpers.js";

const NEW_OB = "0x3000000000000000000000000000000000000003";
const NEW_CH = "0x4000000000000000000000000000000000000004";
const NEW_ORACLE = "0x5000000000000000000000000000000000000005";
const MARKET_ID = "0x" + "ab".repeat(32);

describe("OracleAdapter", () => {
  it("prices, guard trips, params", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "OracleAdapter", event: "PriceUpdated", srcAddress: A.ORACLE, block: blk(1), params: { priceWad: 29n * 10n ** 15n, publishTime: 1_790_000_000n, source: 0n } },
            { contract: "OracleAdapter", event: "PriceUpdated", srcAddress: A.ORACLE, block: blk(2), params: { priceWad: 30n * 10n ** 15n, publishTime: 1_790_000_001n, source: 1n } },
            { contract: "OracleAdapter", event: "DeviationGuardTripped", srcAddress: A.ORACLE, block: blk(3), params: { primaryWad: 29n * 10n ** 15n, secondaryWad: 35n * 10n ** 15n } },
            { contract: "OracleAdapter", event: "OracleParamsUpdated", srcAddress: A.ORACLE, block: blk(4), params: { maxStalenessSec: 30n, maxDeviationWad: 2n * 10n ** 16n } },
          ],
        },
      },
    });
    const prices = await indexer.OraclePrice.getAll();
    expect(prices.map((p) => p.source).sort()).toEqual(["Primary", "Secondary"]);
    expect((await indexer.OracleGuardTrip.getAll())[0]).toMatchObject({ oracle: A.ORACLE, secondaryWad: 35n * 10n ** 15n });
    expect((await indexer.AdminEvent.getAll())[0]).toMatchObject({ name: "OracleParamsUpdated", data: { maxStalenessSec: "30" } });
  });
});

describe("InsuranceFund", () => {
  it("funded, bad debt covered, market authorization", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "InsuranceFund", event: "Funded", srcAddress: A.IF, block: blk(1), params: { from: ALICE, amountToken: 1_500_000_000n } },
            { contract: "InsuranceFund", event: "MarketAuthorized", srcAddress: A.IF, block: blk(1), params: { market: A.CH, authorized: true } },
            { contract: "InsuranceFund", event: "MarketAuthorized", srcAddress: A.IF, block: blk(1), params: { market: A.SWAP, authorized: true } },
            { contract: "InsuranceFund", event: "BadDebtCovered", srcAddress: A.IF, block: blk(2), params: { market: A.CH, requestedToken: 3_000_000n, coveredToken: 2_000_000n } },
            { contract: "InsuranceFund", event: "MarketAuthorized", srcAddress: A.IF, block: blk(3), params: { market: A.SWAP, authorized: false } },
          ],
        },
      },
    });
    expect(await indexer.InsuranceFund.getOrThrow(A.IF)).toMatchObject({ fundedToken: 1_500_000_000n, coveredToken: 2_000_000n, authorizedMarkets: [A.CH] });
    expect((await indexer.BadDebtEvent.getAll())[0]).toMatchObject({ requested: 3_000_000n, covered: 2_000_000n, uncovered: 1_000_000n });
  });
});

describe("MarketFactory", () => {
  it("registers a new market's contracts dynamically and routes its events", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "MarketFactory", event: "MarketRegistered", srcAddress: A.FACTORY, block: blk(1), params: { marketId: MARKET_ID, symbol: "ETH-PERP", orderBook: NEW_OB, clearingHouse: NEW_CH, oracle: NEW_ORACLE } },
          ],
        },
      },
    });
    expect(indexer.chains[CHAIN].OrderBook.addresses).toContain(NEW_OB);
    expect(indexer.chains[CHAIN].ClearingHouse.addresses).toContain(NEW_CH);
    expect(indexer.chains[CHAIN].OracleAdapter.addresses).toContain(NEW_ORACLE);
    expect(await indexer.Market.getOrThrow(NEW_CH)).toMatchObject({ marketId: MARKET_ID, symbol: "ETH-PERP", orderBook: NEW_OB, oracle: NEW_ORACLE, active: true });

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "OrderBook", event: "OrderPlaced", srcAddress: NEW_OB, block: blk(2), params: { orderId: 1n, maker: BOB, isBid: true, tick: 1n, lots: 1n, flags: 0n } },
            { contract: "MarketFactory", event: "MarketStatusChanged", srcAddress: A.FACTORY, block: blk(3), params: { marketId: MARKET_ID, active: false } },
          ],
        },
      },
    });
    expect((await indexer.Order.getOrThrow(`${NEW_OB}-1`)).market).toBe(NEW_CH);
    expect((await indexer.Market.getOrThrow(NEW_CH)).active).toBe(false);
  });
});

describe("PulseKeeperReceiver (Chainlink CRE)", () => {
  it("reports and forwarder updates", async () => {
    const indexer = createTestIndexer();
    const wf = "0x" + "11".repeat(32);
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "PulseKeeperReceiver", event: "ReportExecuted", srcAddress: A.RECEIVER, block: blk(1), params: { action: 1n, success: true, workflowId: wf } },
            { contract: "PulseKeeperReceiver", event: "ReportExecuted", srcAddress: A.RECEIVER, block: blk(2), params: { action: 2n, success: false, workflowId: wf } },
            { contract: "PulseKeeperReceiver", event: "ForwarderUpdated", srcAddress: A.RECEIVER, block: blk(3), params: { forwarder: ALICE } },
          ],
        },
      },
    });
    expect(await indexer.KeeperReport.getAll()).toHaveLength(2);
    expect(await indexer.ProtocolStats.getOrThrow("protocol")).toMatchObject({ keeperReports: 2, keeperReportFailures: 1 });
    expect((await indexer.AdminEvent.getAll())[0]).toMatchObject({ name: "ForwarderUpdated" });
  });
});
