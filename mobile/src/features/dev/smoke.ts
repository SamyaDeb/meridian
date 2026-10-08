// Hermes smoke checks (N2 §4.7): run on the phone, each returns pass/fail + ms. Closes N1's open "Hermes runtime cost
// and globals" item (packages/core/README §Open). Test inputs are derived at runtime from an obviously synthetic seed
// (32 bytes of 0x07): no key material, nothing printed but lengths, timings and public facts.
import chAbi from "@meridian/abis/ClearingHouse.json";
import { deriveEvmKey, derivePerplKey } from "@meridian/core/keys";
import { createPerplClient, httpTransport, signCanonical } from "@meridian/core/perpl";
import { base64UrlDecode, parseBig, stringifyBig, type FetchLike } from "@meridian/core/util";
import * as ed from "@noble/ed25519";
import type { PublicClient } from "viem";

export type SmokeResult = { name: string; ok: boolean; ms: number; detail: string };
export type SmokeCheck = { name: string; run: () => Promise<string> | string };

const SYNTHETIC_SEED = (): Uint8Array => new Uint8Array(32).fill(7);

function must(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

export function smokeChecks(deps: { client: PublicClient | undefined; perplApiUrl: string | undefined; fetch: FetchLike; chainId: number }): SmokeCheck[] {
  return [
    {
      name: "crypto.getRandomValues",
      run: () => {
        const a = new Uint8Array(32);
        globalThis.crypto.getRandomValues(a);
        must(a.some((b) => b !== 0), "returned all zeros");
        return "32 random bytes";
      },
    },
    {
      name: "TextEncoder / TextDecoder",
      run: () => {
        must(typeof TextEncoder === "function", "TextEncoder missing");
        const bytes = new TextEncoder().encode("Meridian ✓");
        must(bytes.length === 12, `utf-8 length ${bytes.length} ≠ 12`);
        must(typeof TextDecoder === "function" && new TextDecoder().decode(bytes) === "Meridian ✓", "TextDecoder round trip");
        return "utf-8 round trip";
      },
    },
    {
      name: "atob / btoa",
      run: () => {
        must(typeof atob === "function" && typeof btoa === "function", "missing");
        must(btoa("meridian") === "bWVyaWRpYW4=" && atob("bWVyaWRpYW4=") === "meridian", "wrong output");
        return "base64 round trip";
      },
    },
    {
      name: "structuredClone",
      run: () => {
        must(typeof structuredClone === "function", "missing");
        const src = { a: [1, 2], m: new Map([["k", 1]]) };
        const c = structuredClone(src);
        must(c !== src && c.a[1] === 2 && c.m.get("k") === 1, "clone mismatch");
        return "deep clone";
      },
    },
    {
      name: "Ed25519 sign / verify (core)",
      run: async () => {
        const k = derivePerplKey(SYNTHETIC_SEED(), deps.chainId);
        const msg = "meridian/n2-smoke";
        const sig = base64UrlDecode(await signCanonical(msg, k.secret));
        must(sig.length === 64, `signature ${sig.length} B`);
        must(ed.verify(sig, new TextEncoder().encode(msg), k.publicKey), "verify failed");
        k.secret.fill(0);
        return "64 B signature verifies";
      },
    },
    {
      name: "deriveEvmKey (PBKDF2-SHA512 × 2048)",
      run: () => {
        const pk = deriveEvmKey(SYNTHETIC_SEED(), 0);
        must(pk.length === 32, "bad key length");
        pk.fill(0);
        return "32 B key (wiped)";
      },
    },
    {
      name: "JSON ABI import",
      run: () => {
        const abi = chAbi as readonly { type: string; name?: string }[];
        must(abi.some((x) => x.type === "function" && x.name === "previewFundingState"), "previewFundingState missing");
        return `${abi.length} ABI entries`;
      },
    },
    {
      name: "bigint JSON round trip",
      run: () => {
        const v = { a: 2n ** 200n + 1n, b: -5n };
        const back = parseBig(stringifyBig(v)) as typeof v;
        must(back.a === v.a && back.b === v.b, "mismatch");
        return "2^200 + 1 exact";
      },
    },
    {
      name: "viem getBlockNumber",
      run: async () => {
        must(deps.client !== undefined, "no RPC configured");
        const b = await deps.client!.getBlockNumber({ cacheTime: 0 });
        return `block ${b}`;
      },
    },
    {
      name: "Perpl REST /v1/pub/context",
      run: async () => {
        must(deps.perplApiUrl !== undefined, "Perpl not configured");
        const ctx = await createPerplClient({ transport: httpTransport(deps.perplApiUrl!, deps.fetch), attempts: 1 }).getContext();
        return `${ctx.markets.length} markets, chain ${ctx.chain.chain_id}`;
      },
    },
  ];
}

export async function runSmoke(checks: readonly SmokeCheck[], now: () => number = () => performance.now()): Promise<SmokeResult[]> {
  const out: SmokeResult[] = [];
  for (const c of checks) {
    const t0 = now();
    try {
      const detail = await c.run();
      out.push({ name: c.name, ok: true, ms: now() - t0, detail });
    } catch (e) {
      out.push({ name: c.name, ok: false, ms: now() - t0, detail: e instanceof Error ? e.message.split("\n")[0]!.replace(/\b(?:https?|wss?):\/\/\S+/gi, "<url>") : String(e) });
    }
  }
  return out;
}
