// Records both MON books on testnet (10143), read-only, for the recorded-fixture quote test (no network in CI):
//   Meridian: OrderBook.getDepth(bid/ask, 32) + tickSize() + lotSize(), ClearingHouse.riskParams() / markPrice() /
//             fundingParams() / previewFundingState(), at one block (deployments/10143.json addresses);
//   Perpl:    GET /v1/market-data/<mon>/book?levels=100 + /ticker (deployments/perpl.json contextUrl → API base).
// RPC: MONAD_TESTNET_RPC_URL if set, else the public testnet RPC listed in docs/ARCHITECTURE.md R29.
//   pnpm --filter @meridian/core record:books   → fixtures/books/testnet-<iso>.json (commit it)
//   MERIDIAN_BLOCK=<n> reads Meridian at a past block (archive RPC); the Perpl REST book is always the current one.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";
import { clearingHouseAbi, orderBookAbi, readMeridianDeployment, readPerplDeployment } from "../src/meridian";

const root = new URL("../../../", import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8")) as unknown;
const CHAIN = 10143;
const m = readMeridianDeployment(json("deployments/10143.json"), CHAIN);
const p = readPerplDeployment(json("deployments/perpl.json"), CHAIN);
const rpc = process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz"; // ARCHITECTURE R29 (public, read-only)
const client = createPublicClient({ chain: monadTestnet, transport: http(rpc) });

const blockNumber = process.env.MERIDIAN_BLOCK ? BigInt(process.env.MERIDIAN_BLOCK) : await client.getBlockNumber();
const ob = { address: m.contracts.OrderBook, abi: orderBookAbi } as const;
const ch = { address: m.contracts.ClearingHouse, abi: clearingHouseAbi } as const;
const [bids, asks, tickSize, lotSize, risk, mark, fparams, fstate] = await Promise.all([
  client.readContract({ ...ob, functionName: "getDepth", args: [true, 32n], blockNumber }),
  client.readContract({ ...ob, functionName: "getDepth", args: [false, 32n], blockNumber }),
  client.readContract({ ...ob, functionName: "tickSize", blockNumber }),
  client.readContract({ ...ob, functionName: "lotSize", blockNumber }),
  client.readContract({ ...ch, functionName: "riskParams", blockNumber }),
  client.readContract({ ...ch, functionName: "markPrice", blockNumber }),
  client.readContract({ ...ch, functionName: "fundingParams", blockNumber }),
  client.readContract({ ...ch, functionName: "previewFundingState", blockNumber }),
]);

const get = async (path: string) => {
  const r = await fetch(`${p.apiUrl}${path}`, { headers: { accept: "application/json" } });
  if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
  return (await r.json()) as unknown;
};
const [perplBook, perplTicker] = await Promise.all([get(`/v1/market-data/${p.monMarketId}/book?levels=100`), get(`/v1/market-data/${p.monMarketId}/ticker`)]);

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const at = new Date().toISOString();
const out = {
  _about: "REAL testnet books, read-only (packages/core/scripts/record-books.ts). Meridian values are decimal strings of the onchain integers.",
  recordedAt: at,
  chainId: CHAIN,
  meridian: {
    block: blockNumber,
    orderBook: m.contracts.OrderBook,
    clearingHouse: m.contracts.ClearingHouse,
    tickSize,
    lotSize,
    bids: { ticks: bids[0], lots: bids[1] },
    asks: { ticks: asks[0], lots: asks[1] },
    riskParams: risk,
    markPrice: mark,
    fundingParams: fparams,
    previewFundingState: fstate,
  },
  perpl: { marketId: p.monMarketId, market: p.markets[p.monMarketId], apiUrl: p.apiUrl, book: perplBook, ticker: perplTicker },
};
mkdirSync(new URL("../fixtures/books/", import.meta.url), { recursive: true });
const file = new URL(`../fixtures/books/testnet-${process.env.MERIDIAN_BLOCK ? `meridian-${blockNumber}` : at.slice(0, 16).replace(/[:]/g, "")}.json`, import.meta.url);
writeFileSync(file, `${JSON.stringify(out, big, 1)}\n`);
console.log(`wrote ${file.pathname}: meridian ${bids[0].length} bids / ${asks[0].length} asks at block ${blockNumber}; perpl ${(perplBook as { bid: unknown[] }).bid.length} / ${(perplBook as { ask: unknown[] }).ask.length}`);
