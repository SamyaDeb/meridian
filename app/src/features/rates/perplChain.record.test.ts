// Records the route fixtures from the live chains. Off unless PERPL_RECORD=1 (CI never touches the network):
//   set -a; . ../.env; set +a; PERPL_RECORD=1 pnpm -C app exec vitest run src/features/rates/perplChain.record.test.ts
import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { readPerplAccount, readPerplMarket, type PerplChainId } from "./perplChain";
import { defaultReader } from "./perplRoutes";
import { recordingReader } from "./recordedReader";

const TARGETS: { name: string; chainId: PerplChainId; address?: string }[] = [
  { name: "account-10143-k3-hedge", chainId: 10143, address: "0xFC76FE796f22665f0A48863Ff5d7a03A4FcD7775" },
  { name: "account-143-1076", chainId: 143, address: "0xf27732351024f7D9a9da128311e13bFa183bde8e" },
  { name: "account-10143-none", chainId: 10143, address: "0x000000000000000000000000000000000000dEaD" },
  { name: "market-10143", chainId: 10143 },
  { name: "market-143", chainId: 143 },
];

describe.skipIf(process.env.PERPL_RECORD !== "1")("record Perpl fixtures (live, opt-in)", () => {
  for (const t of TARGETS)
    it(t.name, async () => {
      const live = defaultReader(t.chainId)!;
      const { reader, recording } = recordingReader(live, `Monad ${t.chainId} via the server RPC, exchange views (deployments/perpl.json)`);
      const out = t.address !== undefined ? await readPerplAccount(reader, t.chainId, t.address) : await readPerplMarket(reader, t.chainId);
      writeFileSync(new URL(`./fixtures/${t.name}.json`, import.meta.url), JSON.stringify({ ...recording, expected: JSON.parse(JSON.stringify(out)) }, null, 1) + "\n");
    }, 60_000);
});
