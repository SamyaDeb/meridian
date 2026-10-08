// Hermes guard: packages/core/src must run on React Native's Hermes, so no Node built-ins, no Buffer / require / process
// env reads, no WebCrypto subtle, no DOM, no storage, no logging, and only the allow-listed packages. (Compile-time
// half: tsconfig.json gives src no Node or DOM types.) The device smoke is N2 (the app imports core on the phone).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
/** Source without comments (so the docs may name what the code must not use). */
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const FORBIDDEN: [RegExp, string][] = [
  [/from\s+["']node:/, "node: import"],
  [/\brequire\s*\(/, "require("],
  [/\bBuffer\b/, "Buffer"],
  [/\bprocess\.env\b/, "process.env read"],
  [/\bcrypto\.subtle\b/, "WebCrypto subtle (absent on Hermes)"],
  [/from\s+["'](crypto|fs|path|os|http|https|net|tls|stream|zlib|child_process|worker_threads)["']/, "Node built-in import"],
  [/\b(window|document|localStorage|sessionStorage|indexedDB)\./, "DOM / browser storage"],
  [/\bAsyncStorage\b|\bSecureStore\b/, "storage (core never persists anything itself)"],
  [/\bconsole\.(log|info|warn|error|debug)\b/, "logging (callers log through redact())"],
  [/\bethers\b/, "ethers (viem only)"],
];
const ALLOWED_PACKAGES = ["viem", "viem/accounts", "@noble/hashes/sha2", "@noble/hashes/hkdf", "@noble/hashes/utils", "@noble/ed25519", "@scure/bip32", "@scure/bip39", "@scure/bip39/wordlists/english"];

describe("Hermes-safe source (packages/core/src)", () => {
  const all = files(SRC);
  it("has source files to check", () => expect(all.length).toBeGreaterThan(20));
  it.each(FORBIDDEN)("no %s", (re) => {
    const hits = all.filter((f) => re.test(code(f))).map((f) => f.slice(SRC.length));
    expect(hits).toEqual([]);
  });
  it("imports only relative modules, the allow-listed packages and @meridian/abis JSON", () => {
    const bad: string[] = [];
    for (const f of all)
      for (const m of code(f).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.startsWith(".") || ALLOWED_PACKAGES.includes(spec) || /^@meridian\/abis\/[A-Za-z0-9]+\.json$/.test(spec)) continue;
        bad.push(`${f.slice(SRC.length)}: ${spec}`);
      }
    expect(bad).toEqual([]);
  });
  it("the guard itself catches what it should (self-test)", () => {
    for (const [re] of FORBIDDEN.slice(0, 3)) expect(re.test(['import x from "node:fs";', "require('x')", "Buffer.from(x)"].join("\n"))).toBe(true);
  });
});
