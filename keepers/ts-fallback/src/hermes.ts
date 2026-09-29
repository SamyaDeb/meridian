// Pyth Hermes client (ARCHITECTURE R24: API key required since 26 Aug 2026; endpoint below; routes unchanged).
import type { Hex } from "viem";
import { pythToWad, type PricePoint } from "./decide.js";

export const DEFAULT_HERMES_URL = "https://pyth.dourolabs.app/hermes"; // ARCHITECTURE R24

export interface HermesUpdate {
  point: PricePoint;
  /** Update data for IOracleAdapter.updatePrice. */
  updateData: Hex[];
}

/** Parse a `/v2/updates/price/latest?encoding=hex` response for one feed. Pure; throws on malformed input. */
export function parseHermesLatest(body: unknown, feedId: Hex): HermesUpdate {
  const b = body as {
    binary?: { data?: unknown };
    parsed?: Array<{ id?: string; price?: { price?: string; expo?: number; publish_time?: number } }>;
  };
  const data = b.binary?.data;
  if (!Array.isArray(data) || data.length === 0 || !data.every((d) => typeof d === "string")) {
    throw new Error("hermes: missing binary.data");
  }
  const want = feedId.toLowerCase().replace(/^0x/, "");
  const feed = b.parsed?.find((p) => p.id?.toLowerCase().replace(/^0x/, "") === want);
  const px = feed?.price;
  if (px?.price === undefined || px.expo === undefined || px.publish_time === undefined) {
    throw new Error(`hermes: feed ${feedId} not in response`);
  }
  const priceWad = pythToWad(BigInt(px.price), px.expo);
  if (priceWad === null) throw new Error(`hermes: unusable price ${px.price}e${px.expo}`);
  return {
    point: { priceWad, publishTime: BigInt(px.publish_time) },
    updateData: (data as string[]).map((d) => (d.startsWith("0x") ? d : `0x${d}`) as Hex),
  };
}

export async function fetchHermesLatest(baseUrl: string, apiKey: string, feedId: Hex): Promise<HermesUpdate> {
  const url = `${baseUrl}/v2/updates/price/latest?ids[]=${feedId}&encoding=hex&parsed=true`;
  // > VERIFY: how the Hermes API key is passed (header name / scheme) — Pyth docs, R24. Bearer assumed.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(2_000) });
  if (!res.ok) throw new Error(`hermes: HTTP ${res.status}`);
  return parseHermesLatest(await res.json(), feedId);
}
