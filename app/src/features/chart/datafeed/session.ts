// Session price history: the mark and index the app already reads every block, recorded from the moment the page
// opened. Real chain reads, never backfilled; used when the indexer (full history) is not connected. In memory,
// per market, bounded; one sample per second (several ~300 ms blocks share a second, the last one wins).
export type Sample = { time: number; mark: bigint; index: bigint };

export const MAX_SAMPLES = 43_200; // 12 h at one per second
const store = new Map<string, Sample[]>();

/** Pure: appends `s` to `list` (replacing a same-second sample, ignoring older ones), bounded to `max`. */
export function appendSample(list: Sample[], s: Sample, max = MAX_SAMPLES): Sample[] {
  const last = list[list.length - 1];
  if (last && s.time < last.time) return list;
  if (last && s.time === last.time) list[list.length - 1] = s;
  else list.push(s);
  if (list.length > max) list.splice(0, list.length - max);
  return list;
}

export function recordSample(market: string, s: Sample): void {
  if (s.mark <= 0n && s.index <= 0n) return;
  const k = market.toLowerCase();
  store.set(k, appendSample(store.get(k) ?? [], s));
}
export const sessionSamples = (market: string): readonly Sample[] => store.get(market.toLowerCase()) ?? [];
