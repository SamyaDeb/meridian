// Record / replay of PerplReader traffic for tests (no network in CI). A recording wraps a live client and stores every
// getBlockNumber and multicall (function names, args, results); replay serves them back in order and fails on any
// call that differs from the recording.
import type { PerplReader } from "./perplChain";

type Tagged = string | number | boolean | null | Tagged[] | { [k: string]: Tagged };
export type Recording = { recordedAt: string; source: string; calls: ({ kind: "block"; result: Tagged } | { kind: "multicall"; calls: Tagged; results: Tagged })[] };

const enc = (v: unknown): Tagged => {
  if (typeof v === "bigint") return `${v}n`;
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "abi" && k !== "error").map(([k, x]) => [k, enc(x)]));
  return (v ?? null) as Tagged;
};
const dec = (v: Tagged): unknown => {
  if (typeof v === "string" && /^-?\d+n$/.test(v)) return BigInt(v.slice(0, -1));
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
  return v;
};
const shape = (contracts: readonly { functionName: string; args?: readonly unknown[] }[]) => enc(contracts.map((c) => ({ fn: c.functionName, args: c.args ?? [] })));

export function recordingReader(live: PerplReader, source: string): { reader: PerplReader; recording: Recording } {
  const recording: Recording = { recordedAt: new Date().toISOString(), source, calls: [] };
  const reader: PerplReader = {
    getBlockNumber: async () => {
      const b = await live.getBlockNumber();
      recording.calls.push({ kind: "block", result: enc(b) });
      return b;
    },
    multicall: async (a) => {
      const r = await live.multicall(a);
      recording.calls.push({ kind: "multicall", calls: shape(a.contracts), results: enc(r.map((x) => (x.status === "success" ? x : { status: "failure" }))) });
      return r;
    },
  } as PerplReader;
  return { reader, recording };
}

export function replayReader(rec: Recording): PerplReader {
  let i = 0;
  const next = (kind: "block" | "multicall") => {
    const c = rec.calls[i++];
    if (!c || c.kind !== kind) throw new Error(`replay: expected ${c?.kind ?? "end"} at ${i - 1}, got ${kind}`);
    return c;
  };
  return {
    getBlockNumber: async () => dec((next("block") as { result: Tagged }).result) as bigint,
    multicall: async (a) => {
      const c = next("multicall") as { calls: Tagged; results: Tagged };
      if (JSON.stringify(shape(a.contracts)) !== JSON.stringify(c.calls)) throw new Error("replay: multicall differs from the recording");
      return (dec(c.results) as { status: "success" | "failure"; result?: unknown }[]).map((x) => (x.status === "success" ? { status: "success" as const, result: x.result } : { status: "failure" as const, error: new Error("recorded failure") }));
    },
  } as PerplReader;
}
