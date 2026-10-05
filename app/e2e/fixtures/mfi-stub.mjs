// TEST FIXTURE ONLY: a stand-in for the MFI service (mfi/, docs/MFI.md §7 response shapes) so e2e specs can exercise
// the Rates page's MFI card. Values are SYNTHETIC (MFI.md §8 example A, then a fixed wave). Perpl is excluded for one
// stretch so the chart's gap handling is visible. Never point a real build at it.   node e2e/fixtures/mfi-stub.mjs 8798
import http from "node:http";

const port = Number(process.argv[2] ?? 8798);
const E14 = 10n ** 14n;
const now = Date.now();
const points = Array.from({ length: 60 }, (_, i) => {
  const meridian = BigInt(1000 + Math.round(400 * Math.sin(i / 6))) * E14; // ≈ 6–14% APR
  const perpl = i >= 30 && i < 38 ? null : BigInt(900 + Math.round(250 * Math.cos(i / 8))) * E14;
  const mfi = perpl === null ? meridian : (meridian * 729n + perpl * 9271n) / 10000n;
  return { updatedAt: now - (59 - i) * 60_000, aprWad: String(mfi), meridianAprWad: String(meridian), perplAprWad: perpl === null ? null : String(perpl), venuesIncluded: perpl === null ? ["meridian"] : ["meridian", "perpl"], stale: false };
});
const last = points[points.length - 1];
const current = {
  version: "mfi-v0",
  chainId: 10143,
  index: { aprWad: last.aprWad, weighting: "oi" },
  stale: false,
  warmup: false,
  updatedBlock: "41234567",
  updatedAt: last.updatedAt,
  venuesIncluded: ["meridian", "perpl"],
  venues: [
    { id: "meridian", included: true, status: "ok", aprWad: last.meridianAprWad, weightBps: 729 },
    { id: "perpl", included: true, status: "ok", aprWad: last.perplAprWad, weightBps: 9271 },
  ],
};
http
  .createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = path === "/v1/mfi" ? current : path === "/v1/mfi/history" ? { version: "mfi-v0", points } : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  })
  .listen(port, () => console.log(`mfi stub on ${port} (synthetic, test only)`));
