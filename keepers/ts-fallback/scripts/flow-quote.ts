// Records ONE Kuru Flow quote (read-only: no transaction) for the vault's spot leg: the test fixture for
// src/kuruflow.ts and the `KURU_FLOW_ROUTE` of contracts/test/fork/KuruHedgerFork.t.sol.
// Usage (the owner runs it; it calls ws.kuru.io, which issues a token for USER_ADDRESS):
//   USER_ADDRESS=<KuruHedger or any address> SIDE=buy|sell AMOUNT=<base units of tokenIn> [KURU_FLOW_JWT=… | KURU_API_KEY=…]
//   [ENTRYPOINT=0xb3e6…13cb] [OUT=test/fixtures/kuru-quote.recorded.json] pnpm flow-quote
// buy = AUSD → WMON (AMOUNT in AUSD 6 dp), sell = WMON → AUSD (AMOUNT in wei). Prints the route hex on stdout.
import { writeFileSync } from "node:fs";
import type { Address } from "viem";
import { FlowClient, parseQuote, quoteRequest } from "../src/kuruflow.js";

// Mainnet tokens and entrypoint: contracts/script/config/143.json (ARCHITECTURE R9, R16).
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as Address;
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address;
const ENTRY = (process.env.ENTRYPOINT ?? "0xb3e6778480b2E488385E8205eA05E20060B813cb") as Address;

const user = process.env.USER_ADDRESS;
if (user === undefined || !/^0x[0-9a-fA-F]{40}$/.test(user)) throw new Error("set USER_ADDRESS=<0x… address that will send the route>");
const side = process.env.SIDE ?? "buy";
const amount = BigInt(process.env.AMOUNT ?? "10000000"); // 10 AUSD
const [tokenIn, tokenOut] = side === "buy" ? [AUSD, WMON] : [WMON, AUSD];
const client = new FlowClient(fetch as never, user as Address, {
  staticJwt: process.env.KURU_FLOW_JWT,
  apiKey: process.env.KURU_API_KEY,
});
const resp = await client.quote(
  quoteRequest({ hedger: user as Address, tokenIn, tokenOut, amountIn: amount, slippageBps: Number(process.env.SLIPPAGE_BPS ?? "50") }),
);
const out = process.env.OUT ?? "test/fixtures/kuru-quote.recorded.json";
writeFileSync(
  out,
  JSON.stringify({ _provenance: `recorded ${new Date().toISOString()} ${side} ${amount} for ${user}`, ...(resp as object) }, null, 2) + "\n",
);
const route = parseQuote(resp, ENTRY); // throws if the target isn't the entrypoint or value ≠ 0
console.error(`saved ${out}; expected out ${route.expectedOut}; route ${(route.data.length - 2) / 2} bytes`);
console.log(route.data);
