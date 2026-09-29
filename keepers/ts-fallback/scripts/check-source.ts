// Prints what the keeper-fed test oracle would push right now, from each keyless source (RUNBOOK: "verify the source").
// Usage: MONAD_RPC_URL=<mainnet rpc> PYTH_MON_USD_FEED_ID=0x3149…6cd1 pnpm check-source
import { type Hex, createPublicClient, formatUnits, http } from "viem";
import { latestKeylessPrice } from "../src/pricesource.js";

const feed = process.env.PYTH_MON_USD_FEED_ID as Hex | undefined;
if (feed === undefined) throw new Error("missing env PYTH_MON_USD_FEED_ID");
const rpc = process.env.MONAD_RPC_URL;
const now = BigInt(Math.floor(Date.now() / 1000));
const show = (label: string, p: Awaited<ReturnType<typeof latestKeylessPrice>>): void =>
  console.log(label, p === null ? "none" : { source: p.source, price: formatUnits(p.priceWad, 18), ageSec: Number(now - p.publishTime) });
if (rpc !== undefined) show("primary:", await latestKeylessPrice(createPublicClient({ transport: http(rpc) }), feed, now, 60n));
show("fallback:", await latestKeylessPrice(null, feed, now, 60n));
