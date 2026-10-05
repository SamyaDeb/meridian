// CrashDemo CSV sanity (Phase 3 P3). Usage: pnpm crash-sanity <csv> [--vault idle|hedged] [--compare <csv> --compare-vault idle|hedged]
// Exit 1 if any check fails. See src/crashSanity.ts for the invariants.
import { readFileSync } from "node:fs";
import { checkCrash, parseCrashCsv, summarize } from "./src/crashSanity.js";

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : d;
};
const file = args[0];
if (!file) throw new Error("usage: crash_sanity.ts <csv> [--vault idle|hedged] [--compare <csv> --compare-vault idle|hedged]");
let failed = false;
const run = (path: string, vault: string): void => {
  const rows = parseCrashCsv(readFileSync(path, "utf8"));
  const f = checkCrash(rows, { vault: vault === "hedged" ? "hedged" : "idle" });
  console.log(`${path} (${vault} vault): ${summarize(rows)}`);
  for (const x of f) console.log(`  FAIL ${x}`);
  console.log(f.length === 0 ? "  PASS all checks" : `  ${f.length} check(s) failed`);
  failed ||= f.length > 0;
};
run(file, opt("--vault", "idle"));
const cmp = opt("--compare", "");
if (cmp) run(cmp, opt("--compare-vault", "hedged"));
process.exit(failed ? 1 : 0);
