// Turns a recorded crash run (bench/out/crash_demo_*.csv, written by the CrashDemo forge script) into the JSON the
// Rates & Risk replay panel reads. Values stay as integer strings (WAD / AUSD token units). Rerun after a new recording:
//   node app/scripts/gen-crash-replay.mjs
import { readFileSync, writeFileSync } from "node:fs";

export const RUNS = [
  {
    id: "local-10143",
    csv: "bench/out/crash_demo_10143_local.csv",
    label: "Local test market (anvil, chain id 10143): not testnet or mainnet evidence",
    explorer: null,
  },
];

export function parseCrashCsv(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const notes = lines.filter((l) => l.startsWith("#")).map((l) => l.replace(/^#\s?/, ""));
  const [head, ...rows] = lines.filter((l) => !l.startsWith("#"));
  const cols = head.split(",");
  return {
    notes,
    rows: rows.map((r) => {
      const v = r.split(",");
      if (v.length !== cols.length) throw new Error(`bad row: ${r}`);
      return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    }),
  };
}

const root = new URL("../../", import.meta.url);
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = RUNS.map((r) => ({ ...r, ...parseCrashCsv(readFileSync(new URL(r.csv, root), "utf8")) }));
  writeFileSync(new URL("app/src/features/rates/crashReplay.gen.json", root), JSON.stringify(out, null, 1) + "\n");
  console.log(out.map((r) => `${r.id}: ${r.rows.length} blocks`).join("\n"));
}
