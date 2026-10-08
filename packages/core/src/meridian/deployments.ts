// Deployment READERS: take the parsed deployments/<chainId>.json and deployments/perpl.json objects and return typed,
// validated views. Not a config system (LAUNCH_PLAN §3.1: packages/config owns loading + per-env URLs); core never
// hard-codes an address, chain or market id. A record with `deployed: false`, or no record (143.json is absent until
// mainnet day), reads as "not deployed" and is refused by the throwing variant.
import { getAddress, isAddress, type Address } from "viem";

export type MeridianContracts = {
  AUSD: Address;
  ClearingHouse: Address;
  OrderBook: Address;
  FundingSwapMarket?: Address;
  SwapOrderBook?: Address;
  MeridianVault?: Address;
  InsuranceFund?: Address;
  OracleAdapter?: Address;
  MarketFactory?: Address;
  WMON?: Address;
};

export type MeridianDeployment = {
  chainId: number;
  contracts: MeridianContracts;
  /** contracts that are mocks on this chain (e.g. testnet AUSD): the app labels them */
  mockContracts: string[];
  startBlock: bigint | undefined;
  symbol: string | undefined;
};

export type DeploymentRead<T> = { status: "deployed"; deployment: T } | { status: "not-deployed"; reason: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function addr(o: Obj, k: string, where: string): Address {
  const v = o[k];
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`${where}.${k}: expected an address`);
  return getAddress(v);
}

const REQUIRED = ["AUSD", "ClearingHouse", "OrderBook"] as const;
const OPTIONAL = ["FundingSwapMarket", "SwapOrderBook", "MeridianVault", "InsuranceFund", "OracleAdapter", "MarketFactory", "WMON"] as const;

/** deployments/<chainId>.json → typed view, or why it isn't usable. `json` undefined = the file doesn't exist. */
export function tryReadMeridianDeployment(json: unknown, chainId: number): DeploymentRead<MeridianDeployment> {
  if (json === undefined || json === null) return { status: "not-deployed", reason: `no deployments/${chainId}.json` };
  if (!isObj(json)) throw new Error(`deployments/${chainId}.json: expected an object`);
  if (json.chainId !== chainId) throw new Error(`deployments/${chainId}.json: chainId ${String(json.chainId)} ≠ ${chainId}`);
  if (json.deployed === false) return { status: "not-deployed", reason: `deployments/${chainId}.json says deployed: false` };
  if (!isObj(json.contracts)) throw new Error(`deployments/${chainId}.json: contracts missing`);
  const c = json.contracts;
  const where = `deployments/${chainId}.json contracts`;
  const contracts = Object.fromEntries(REQUIRED.map((k) => [k, addr(c, k, where)])) as MeridianContracts;
  for (const k of OPTIONAL) if (c[k] !== undefined) (contracts as Record<string, Address>)[k] = addr(c, k, where);
  const mocks = Array.isArray(json.mockContracts) ? json.mockContracts.filter((x): x is string => typeof x === "string") : [];
  const sb = json.startBlock;
  return {
    status: "deployed",
    deployment: { chainId, contracts, mockContracts: mocks, startBlock: typeof sb === "number" && Number.isSafeInteger(sb) ? BigInt(sb) : undefined, symbol: typeof json.symbol === "string" ? json.symbol : undefined },
  };
}

/** Throwing variant: the app calls this only on a chain it is configured to trade on. */
export function readMeridianDeployment(json: unknown, chainId: number): MeridianDeployment {
  const r = tryReadMeridianDeployment(json, chainId);
  if (r.status !== "deployed") throw new Error(`Meridian is not deployed on chain ${chainId}: ${r.reason}`);
  return r.deployment;
}

export type PerplMarketMeta = { id: number; name: string; symbol: string; priceDecimals: number; sizeDecimals: number; fundingIntervalSec: number; fundingIntervalBlocks: number };

export type PerplDeployment = {
  chainId: number;
  exchange: Address;
  collateralToken: Address;
  collateralDecimals: number;
  monMarketId: number;
  /** REST base derived from `contextUrl` (…/api/v1/pub/context ⇒ …/api); the WS base comes from packages/config */
  apiUrl: string;
  markets: Record<number, PerplMarketMeta>;
  fetched: string | undefined;
};

const intIn = (v: unknown, lo: number, hi: number, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < lo || v > hi) throw new Error(`${what}: expected an integer in [${lo}, ${hi}]`);
  return v;
};

/** deployments/perpl.json → the chain's Perpl venue (addresses, collateral decimals, markets copied from /v1/pub/context). */
export function tryReadPerplDeployment(json: unknown, chainId: number): DeploymentRead<PerplDeployment> {
  if (!isObj(json) || !isObj(json.chains)) throw new Error("deployments/perpl.json: expected { chains }");
  const ch = json.chains[String(chainId)];
  if (ch === undefined) return { status: "not-deployed", reason: `perpl.json has no chain ${chainId}` };
  if (!isObj(ch)) throw new Error(`perpl.json chains.${chainId}: expected an object`);
  const where = `perpl.json chains.${chainId}`;
  const ctx = ch.contextUrl;
  if (typeof ctx !== "string" || !/^https:\/\/.+\/v1\/pub\/context$/.test(ctx)) throw new Error(`${where}.contextUrl: expected https://…/v1/pub/context`);
  if (!isObj(ch.markets)) throw new Error(`${where}.markets: expected an object`);
  const markets: Record<number, PerplMarketMeta> = {};
  for (const [k, m] of Object.entries(ch.markets)) {
    if (!isObj(m)) throw new Error(`${where}.markets.${k}: expected an object`);
    const id = Number(k);
    markets[id] = {
      id,
      name: String(m.name ?? ""),
      symbol: String(m.symbol ?? ""),
      priceDecimals: intIn(m.priceDecimals, 0, 18, `${where}.markets.${k}.priceDecimals`),
      sizeDecimals: intIn(m.sizeDecimals, 0, 18, `${where}.markets.${k}.sizeDecimals`),
      fundingIntervalSec: intIn(m.fundingIntervalSec, 1, 1e9, `${where}.markets.${k}.fundingIntervalSec`),
      fundingIntervalBlocks: intIn(m.fundingIntervalBlocks, 1, 1e12, `${where}.markets.${k}.fundingIntervalBlocks`),
    };
  }
  const monMarketId = intIn(ch.monMarketId, 0, 2 ** 31, `${where}.monMarketId`);
  if (!markets[monMarketId]) throw new Error(`${where}: monMarketId ${monMarketId} is not in markets`);
  return {
    status: "deployed",
    deployment: {
      chainId,
      exchange: addr(ch, "exchange", where),
      collateralToken: addr(ch, "collateralToken", where),
      collateralDecimals: intIn(ch.collateralDecimals, 0, 18, `${where}.collateralDecimals`),
      monMarketId,
      apiUrl: ctx.replace(/\/v1\/pub\/context$/, ""),
      markets,
      fetched: typeof ch.fetched === "string" ? ch.fetched : undefined,
    },
  };
}

export function readPerplDeployment(json: unknown, chainId: number): PerplDeployment {
  const r = tryReadPerplDeployment(json, chainId);
  if (r.status !== "deployed") throw new Error(`Perpl is not configured on chain ${chainId}: ${r.reason}`);
  return r.deployment;
}
