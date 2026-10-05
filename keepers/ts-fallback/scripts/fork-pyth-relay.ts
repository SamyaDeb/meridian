// FORK-ONLY tool (Phase 3 P2–P4): keeps Pyth MON/USD fresh on a local anvil fork of Monad mainnet by replaying the
// REAL signed Pyth updates that sponsored pushers land on mainnet. A fork is frozen (no sponsored pushes reach it) and
// its clock follows wall time, so the adapter (maxStalenessSec 60) goes stale a minute after the fork starts. Without a
// Hermes API key (HUMAN_CHECKLIST #6) the only honest price source is mainnet itself: this reads the newest
// `PriceFeedUpdate(id)` on mainnet, takes the Pyth accumulator payload ("PNAU") out of that tx's calldata, and submits
// it to the fork's Pyth (`updatePriceFeeds` is permissionless; the payload is verified onchain by Pyth's guardians'
// signatures, so a wrong payload cannot set a price). Prices on the fork are therefore real mainnet prices, ~1–30 s
// old, exactly as sponsored. NOT a production component: on 143 the keeper (Hermes) or the sponsored pushes do this.
//
// Usage: MONAD_RPC_URL=<mainnet, read-only> FORK_RPC_URL=http://127.0.0.1:8545 pnpm fork-pyth-relay
// Refuses a non-local FORK_RPC_URL and any node that does not answer `anvil_nodeInfo`. Signs with anvil dev key #7.
import { type Hex, createPublicClient, createWalletClient, http, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// docs/ARCHITECTURE.md §0 R12
const PYTH = "0x2880aB155794e7179c9eE2e38200202908C17B43";
const MON_USD_ID: Hex = "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1";
const PNAU = "504e4155"; // Pyth accumulator update magic ("PNAU")

const pythAbi = parseAbi([
  "struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }",
  "function getPriceUnsafe(bytes32 id) view returns (Price)",
  "function getUpdateFee(bytes[] updateData) view returns (uint256)",
  "function updatePriceFeeds(bytes[] updateData) payable",
]);
const priceFeedUpdate = parseAbiItem("event PriceFeedUpdate(bytes32 indexed id, uint64 publishTime, int64 price, uint64 conf)");

/**
 * Every Pyth accumulator payload ABI-encoded as a `bytes` value inside `input`: the "PNAU" magic at a 32-byte word
 * boundary, preceded by its length word. Works whatever wrapper contract the sponsor calls (the payload sits in a
 * `bytes[]` argument either way). Payloads whose length word runs past the calldata are ignored.
 */
export function extractPythUpdates(input: Hex): Hex[] {
  const body = input.slice(2 + 8); // drop 0x + selector: ABI words start here
  const out: Hex[] = [];
  for (let w = 1; (w + 1) * 64 <= body.length; w++) {
    const at = w * 64;
    if (body.slice(at, at + PNAU.length) !== PNAU) continue;
    const len = Number.parseInt(body.slice(at - 64, at), 16);
    if (!Number.isSafeInteger(len) || len < 4 || at + len * 2 > body.length) continue;
    out.push(`0x${body.slice(at, at + len * 2)}`);
  }
  return out;
}

/** The fork RPC must be localhost: this script signs and sends transactions. */
export function isLocalRpc(url: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/.test(url);
}

async function main(): Promise<void> {
  const mainnetUrl = process.env.MONAD_RPC_URL;
  const forkUrl = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
  if (!mainnetUrl) throw new Error("MONAD_RPC_URL (mainnet, read-only) is required");
  if (!isLocalRpc(forkUrl)) throw new Error("refusing: FORK_RPC_URL must be localhost");
  const pollMs = Number(process.env.POLL_MS ?? "3000");

  const mainnet = createPublicClient({ transport: http(mainnetUrl) });
  const fork = createPublicClient({ transport: http(forkUrl) });
  await fork.request({ method: "anvil_nodeInfo" as never, params: [] as never }).catch(() => {
    throw new Error("refusing: FORK_RPC_URL is not an anvil node");
  });
  const chainId = await fork.getChainId();
  // anvil dev key #7 (public test key; its mainnet address has no code or 7702 delegation, checked 5 Oct 2026)
  const account = privateKeyToAccount("0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356");
  const wallet = createWalletClient({ account, transport: http(forkUrl) });
  const chain = { id: chainId, name: "anvil-fork", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [forkUrl] } } };

  let lastTx: Hex | undefined;
  console.log(`fork-pyth-relay: FORK-ONLY, replaying mainnet Pyth MON/USD updates onto ${forkUrl} (chain ${chainId})`);
  for (;;) {
    try {
      const head = await mainnet.getBlockNumber();
      const logs = await mainnet.getLogs({ address: PYTH, event: priceFeedUpdate, args: { id: MON_USD_ID }, fromBlock: head - 60n, toBlock: head });
      const newest = logs.at(-1);
      if (newest && newest.transactionHash !== lastTx) {
        const onFork = await fork.readContract({ address: PYTH, abi: pythAbi, functionName: "getPriceUnsafe", args: [MON_USD_ID] });
        if ((newest.args.publishTime ?? 0n) > onFork.publishTime) {
          const tx = await mainnet.getTransaction({ hash: newest.transactionHash });
          const updates = extractPythUpdates(tx.input);
          if (updates.length === 0) throw new Error(`no PNAU payload in ${newest.transactionHash}`);
          const fee = await fork.readContract({ address: PYTH, abi: pythAbi, functionName: "getUpdateFee", args: [updates] });
          const gas = await fork.estimateContractGas({ address: PYTH, abi: pythAbi, functionName: "updatePriceFeeds", args: [updates], value: fee, account });
          const hash = await wallet.writeContract({ address: PYTH, abi: pythAbi, functionName: "updatePriceFeeds", args: [updates], value: fee, chain, gas: (gas * 12n) / 10n });
          await fork.waitForTransactionReceipt({ hash });
          // the fork's clock follows wall time (anvil), so the age the adapter will see is wall clock − publishTime
          const age = BigInt(Math.floor(Date.now() / 1000)) - (newest.args.publishTime ?? 0n);
          console.log(`relayed mainnet ${newest.transactionHash.slice(0, 10)}… publishTime ${newest.args.publishTime} age ${age} s price ${newest.args.price} (expo -8)`);
        }
        lastTx = newest.transactionHash;
      }
    } catch (e) {
      console.error(`fork-pyth-relay: ${(e as Error).message.split("\n")[0]}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
