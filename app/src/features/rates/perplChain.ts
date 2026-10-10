// Server-side reads of Perpl's exchange (K5 position monitor): one multicall per request, read-only, through the
// app's server RPC from env. Addresses and market ids come from deployments/perpl.json (seeded from Perpl's context
// endpoint, indexer/PERPL_EVENTS.md); every view and field is in the vendored ABI indexer/abis/PerplExchange.json.
// Nothing here signs anything.
import { getAddress, isAddress, type Abi, type Address, type PublicClient } from "viem";
import perplRecord from "../../../../deployments/perpl.json";
import exchangeAbiJson from "../../../../indexer/abis/PerplExchange.json";

export const PERPL_CHAINS = [10143, 143] as const;
export type PerplChainId = (typeof PERPL_CHAINS)[number];
export const PERPL_CHAIN_LABEL: Record<PerplChainId, string> = { 10143: "Monad testnet", 143: "Monad mainnet" };
export const isPerplChain = (n: number): n is PerplChainId => (PERPL_CHAINS as readonly number[]).includes(n);

type MarketRecord = { name: string; symbol: string; priceDecimals: number; sizeDecimals: number; fundingIntervalSec: number; fundingIntervalBlocks: number };
type ChainRecord = { exchange: string; monMarketId: number; markets: Record<string, MarketRecord> };
const CHAINS = perplRecord.chains as unknown as Record<string, ChainRecord>;

export function perplChain(chainId: PerplChainId): { exchange: Address; monMarketId: number; markets: Record<string, MarketRecord> } {
  const c = CHAINS[String(chainId)];
  if (!c) throw new Error(`no Perpl record for chain ${chainId}`);
  return { exchange: getAddress(c.exchange), monMarketId: c.monMarketId, markets: c.markets };
}

const NEEDED = new Set([
  "getAccountByAddr",
  "getPositionV2",
  "getMarginFractions",
  "getPerpetualInfoV2",
  "getFundingSumAtBlock",
  "getFundingInterval",
  "getTakerFee",
  "getMakerFee",
]);
/** The views this module calls, cut from the vendored ABI (never hand-written signatures). */
export const PERPL_VIEWS_ABI = (exchangeAbiJson as Abi).filter((f) => f.type === "function" && NEEDED.has(f.name));

/**
 * Server RPC per chain: MONAD_TESTNET_RPC_URL / MONAD_RPC_URL (server-only, CONTRIBUTING §7 names), else the app's
 * public read RPC. Never hard-coded; undefined ⇒ the route says which one is missing.
 */
export function serverRpcUrl(chainId: PerplChainId, env: Record<string, string | undefined> = process.env): string | undefined {
  const v = chainId === 143 ? env.MONAD_RPC_URL || env.NEXT_PUBLIC_MONAD_RPC_URL : env.MONAD_TESTNET_RPC_URL || env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL;
  return v || undefined;
}
export const rpcEnvName = (chainId: PerplChainId) => (chainId === 143 ? "MONAD_RPC_URL" : "MONAD_TESTNET_RPC_URL");

/**
 * Pure: perp ids whose bit is set in the account's position banks (getAccountByAddr().positions.bank1..4, 4 × 256
 * bits; the K3 hedge account's bank1 = 2^64 ⇔ perp 64). Bounded: at most 1,024 ids.
 */
export function perpsFromBanks(banks: readonly bigint[]): number[] {
  const out: number[] = [];
  banks.slice(0, 4).forEach((bank, i) => {
    for (let bit = 0; bit < 256 && bank >> BigInt(bit) !== 0n; bit++) if ((bank >> BigInt(bit)) & 1n) out.push(i * 256 + bit);
  });
  return out;
}

/** Wire format: every integer as a decimal string (bigint-safe JSON). */
export type PerplPositionWire = {
  perpId: number;
  name: string;
  positionType: number;
  depositCNS: string;
  pricePNS: string;
  priceResiduePNSQ16: string;
  lotLNS: string;
  entryBlock: string;
  pnlCNS: string;
  deltaPnlCNS: string;
  premiumPnlCNS: string;
  markPNS: string;
  markValid: boolean;
  priceDecimals: number;
  lotDecimals: number;
  maintMarginHdths: string;
  initMarginHdths: string;
  fundingRatePct100k: string;
  lastFundingEventBlock: string;
  fundingIntervalSec: number;
  fundingIntervalBlocks: string;
  takerFeeMicros: string;
  makerFeeMicros: string;
};
export type PerplAccountWire = {
  chainId: PerplChainId;
  address: Address;
  block: string;
  account: null | { accountId: string; balanceCNS: string; lockedBalanceCNS: string; frozen: number };
  positions: PerplPositionWire[];
  /** perps with a position bit set that deployments/perpl.json doesn't describe (shown, not guessed) */
  unknownPerps: number[];
};

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
type Res = { status: "success"; result: unknown } | { status: "failure"; error: unknown };
export type PerplReader = Pick<PublicClient, "getBlockNumber"> & { multicall: (a: { contracts: Call[]; allowFailure: true; blockNumber?: bigint }) => Promise<Res[]> };

const ok = <T,>(r: Res | undefined, what: string): T => {
  if (!r || r.status !== "success") throw new PerplReadError(`exchange view ${what} failed`);
  return r.result as T;
};
export class PerplReadError extends Error {}

type AccountInfo = { accountId: bigint; balanceCNS: bigint; lockedBalanceCNS: bigint; frozen: number; positions: { bank1: bigint; bank2: bigint; bank3: bigint; bank4: bigint } };
type PositionInfo = { positionType: number; depositCNS: bigint; pricePNS: bigint; lotLNS: bigint; entryBlock: bigint; pnlCNS: bigint; deltaPnlCNS: bigint; premiumPnlCNS: bigint; priceResiduePNSQ16: bigint };
type PerpInfo = { name: string; priceDecimals: bigint; lotDecimals: bigint; markPNS: bigint; fundingRatePct100k: number };

/** One wallet's Perpl account and open positions, read at one block (two multicalls: account, then its markets). */
export async function readPerplAccount(client: PerplReader, chainId: PerplChainId, address: string): Promise<PerplAccountWire> {
  if (!isAddress(address, { strict: false })) throw new RangeError("not an address");
  const addr = getAddress(address);
  const { exchange, markets } = perplChain(chainId);
  const c = (functionName: string, args: readonly unknown[] = []): Call => ({ address: exchange, abi: PERPL_VIEWS_ABI, functionName, args });
  const block = await client.getBlockNumber();
  const [acctRes, ivRes] = await client.multicall({ contracts: [c("getAccountByAddr", [addr]), c("getFundingInterval")], allowFailure: true, blockNumber: block });
  const base = { chainId, address: addr, block: block.toString() };
  // an address without a Perpl account: the view reverts or returns id 0 (> VERIFY which, on Perpl's side); both mean "no account"
  if (!acctRes || acctRes.status !== "success" || (acctRes.result as AccountInfo).accountId === 0n) return { ...base, account: null, positions: [], unknownPerps: [] };
  const a = acctRes.result as AccountInfo;
  const intervalBlocks = ok<bigint>(ivRes, "getFundingInterval");
  const ids = perpsFromBanks([a.positions.bank1, a.positions.bank2, a.positions.bank3, a.positions.bank4]);
  const known = ids.filter((id) => markets[String(id)] !== undefined);
  const per = (id: number) => [
    c("getPositionV2", [BigInt(id), a.accountId]),
    c("getMarginFractions", [BigInt(id), 0n]),
    c("getPerpetualInfoV2", [BigInt(id)]),
    c("getFundingSumAtBlock", [BigInt(id), block]),
    c("getTakerFee", [BigInt(id)]),
    c("getMakerFee", [BigInt(id)]),
  ];
  const res = known.length > 0 ? await client.multicall({ contracts: known.flatMap(per), allowFailure: true, blockNumber: block }) : [];
  const positions: PerplPositionWire[] = [];
  known.forEach((id, i) => {
    const r = res.slice(i * 6, i * 6 + 6);
    const [p, mark, markValid] = ok<[PositionInfo, bigint, boolean]>(r[0], "getPositionV2");
    if (p.lotLNS === 0n) return; // the bit can outlive a closed position: nothing to monitor
    const [initHdths, maintHdths] = ok<readonly bigint[]>(r[1], "getMarginFractions");
    const info = ok<PerpInfo>(r[2], "getPerpetualInfoV2");
    const [, feb] = ok<[bigint, bigint]>(r[3], "getFundingSumAtBlock");
    const rec = markets[String(id)]!;
    // the record's decimals were seeded from Perpl's context; the exchange's own view must agree, else refuse to compute
    if (Number(info.priceDecimals) !== rec.priceDecimals || Number(info.lotDecimals) !== rec.sizeDecimals) throw new PerplReadError(`perp ${id}: decimals differ from deployments/perpl.json`);
    positions.push({
      perpId: id,
      name: rec.symbol || rec.name,
      positionType: Number(p.positionType),
      depositCNS: p.depositCNS.toString(),
      pricePNS: p.pricePNS.toString(),
      priceResiduePNSQ16: p.priceResiduePNSQ16.toString(),
      lotLNS: p.lotLNS.toString(),
      entryBlock: p.entryBlock.toString(),
      pnlCNS: p.pnlCNS.toString(),
      deltaPnlCNS: p.deltaPnlCNS.toString(),
      premiumPnlCNS: p.premiumPnlCNS.toString(),
      markPNS: mark.toString(),
      markValid,
      priceDecimals: rec.priceDecimals,
      lotDecimals: rec.sizeDecimals,
      maintMarginHdths: String(maintHdths),
      initMarginHdths: String(initHdths),
      fundingRatePct100k: String(info.fundingRatePct100k),
      lastFundingEventBlock: feb.toString(),
      fundingIntervalSec: rec.fundingIntervalSec,
      fundingIntervalBlocks: intervalBlocks.toString(),
      takerFeeMicros: ok<bigint>(r[4], "getTakerFee").toString(),
      makerFeeMicros: ok<bigint>(r[5], "getMakerFee").toString(),
    });
  });
  return {
    ...base,
    account: { accountId: a.accountId.toString(), balanceCNS: a.balanceCNS.toString(), lockedBalanceCNS: a.lockedBalanceCNS.toString(), frozen: Number(a.frozen) },
    positions,
    unknownPerps: ids.filter((id) => markets[String(id)] === undefined),
  };
}

export type PerplMarketWire = {
  chainId: PerplChainId;
  perpId: number;
  name: string;
  block: string;
  markPNS: string;
  priceDecimals: number;
  lotDecimals: number;
  fundingRatePct100k: string;
  lastFundingEventBlock: string;
  fundingIntervalSec: number;
  fundingIntervalBlocks: string;
  longOpenInterestLNS: string;
  shortOpenInterestLNS: string;
  takerFeeMicros: string;
  makerFeeMicros: string;
  maintMarginHdths: string;
  initMarginHdths: string;
};

type PerpInfoFull = PerpInfo & { longOpenInterestLNS: bigint; shortOpenInterestLNS: bigint };

/** Perpl's MON market on `chainId` now: rate in force, last funding block, mark, OI, fees, margins (one multicall). */
export async function readPerplMarket(client: PerplReader, chainId: PerplChainId): Promise<PerplMarketWire> {
  const { exchange, monMarketId, markets } = perplChain(chainId);
  const rec = markets[String(monMarketId)]!;
  const id = BigInt(monMarketId);
  const c = (functionName: string, args: readonly unknown[] = []): Call => ({ address: exchange, abi: PERPL_VIEWS_ABI, functionName, args });
  const block = await client.getBlockNumber();
  const r = await client.multicall({
    contracts: [c("getPerpetualInfoV2", [id]), c("getFundingSumAtBlock", [id, block]), c("getFundingInterval"), c("getTakerFee", [id]), c("getMakerFee", [id]), c("getMarginFractions", [id, 0n])],
    allowFailure: true,
    blockNumber: block,
  });
  const info = ok<PerpInfoFull>(r[0], "getPerpetualInfoV2");
  if (Number(info.priceDecimals) !== rec.priceDecimals || Number(info.lotDecimals) !== rec.sizeDecimals) throw new PerplReadError(`perp ${monMarketId}: decimals differ from deployments/perpl.json`);
  const [, feb] = ok<[bigint, bigint]>(r[1], "getFundingSumAtBlock");
  const [initHdths, maintHdths] = ok<readonly bigint[]>(r[5], "getMarginFractions");
  return {
    chainId,
    perpId: monMarketId,
    name: rec.symbol || rec.name,
    block: block.toString(),
    markPNS: info.markPNS.toString(),
    priceDecimals: rec.priceDecimals,
    lotDecimals: rec.sizeDecimals,
    fundingRatePct100k: String(info.fundingRatePct100k),
    lastFundingEventBlock: feb.toString(),
    fundingIntervalSec: rec.fundingIntervalSec,
    fundingIntervalBlocks: ok<bigint>(r[2], "getFundingInterval").toString(),
    longOpenInterestLNS: info.longOpenInterestLNS.toString(),
    shortOpenInterestLNS: info.shortOpenInterestLNS.toString(),
    takerFeeMicros: ok<bigint>(r[3], "getTakerFee").toString(),
    makerFeeMicros: ok<bigint>(r[4], "getMakerFee").toString(),
    maintMarginHdths: String(maintHdths),
    initMarginHdths: String(initHdths),
  };
}
