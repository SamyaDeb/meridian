// TEST FIXTURE ONLY: a GraphQL stub standing in for the Envio indexer so e2e specs can exercise the chart with
// candles. Serves a seeded random walk ending now (Candle1m: 2 days, Candle1h: 30 days) and empty history tables.
// Never point a real build at it.   node e2e/fixtures/indexer-stub.mjs 8799
import http from "node:http";

const port = Number(process.argv[2] ?? 8799);
const WAD = 10n ** 18n;
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function series(sec, count, seed) {
  const r = rng(seed);
  const end = Math.floor(Date.now() / 1000 / sec) * sec;
  let px = 27_000n;
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = end - i * sec;
    const o = px;
    const c = px + BigInt(Math.round((r() - 0.5) * 60));
    const h = (o > c ? o : c) + BigInt(Math.round(r() * 20));
    const l = (o < c ? o : c) - BigInt(Math.round(r() * 20));
    const lots = BigInt(1 + Math.floor(r() * 30));
    const tick = 10n ** 12n;
    out.push({ id: `m-${t}`, market: "stub", bucketStart: String(t), open: String(o * tick), high: String(h * tick), low: String(l * tick), close: String(c * tick), volumeBaseWad: String(lots * 100n * WAD), volumeQuoteWad: String((lots * 100n * c * tick * WAD) / WAD), trades: Number(lots) });
    px = c;
  }
  return out.reverse(); // newest first, like order_by bucketStart desc
}
const C1M = series(60, 2_880, 1);
const C1H = series(3_600, 720, 2);

http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" });
      return res.end();
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { query = "", variables = {} } = JSON.parse(body || "{}");
      const limit = Number(variables.limit ?? 500);
      const data = {};
      if (query.includes("Candle1m(")) data.Candle1m = C1M.slice(0, limit);
      if (query.includes("Candle1h(")) data.Candle1h = C1H.slice(0, limit);
      if (query.includes("Trade(")) data.Trade = [];
      if (query.includes("Order(")) data.Order = [];
      if (query.includes("Liquidation(")) data.Liquidation = [];
      if (query.includes("AccountMarket(")) {
        // synthetic open positions around a 0.026 mark: entries 0.026, collateral 2 %..60 % of notional
        data.AccountMarket = Array.from({ length: 24 }, (_, i) => {
          const size = BigInt((i % 2 ? -1 : 1) * (i + 1)) * 1000n * WAD;
          const entry = 26_000n * 10n ** 12n;
          const notional = ((size < 0n ? -size : size) * entry) / WAD;
          return { size: String(size), entryPrice: String(entry), collateralWad: String((notional * BigInt(2 + i * 2.5 | 0)) / 100n) };
        });
      }
      if (query.includes("OraclePrice(")) {
        // synthetic oracle updates every 5 min over 2 days, newest first
        const end = Math.floor(Date.now() / 1000);
        data.OraclePrice = Array.from({ length: Math.min(limit, 576) }, (_, i) => ({ priceWad: String((26_000n + BigInt(Math.round(Math.sin(i / 9) * 120))) * 10n ** 12n), publishTime: String(end - i * 300) }));
      }
      if (query.includes("FundingTick(")) {
        // synthetic mark per block (300 ms) for the most recent `limit` blocks, newest first
        const endMs = Date.now();
        data.FundingTick = Array.from({ length: limit }, (_, i) => ({ mark: String((26_010n + BigInt(Math.round(Math.cos(i / 40) * 30))) * 10n ** 12n), timestamp: String(Math.floor((endMs - i * 300) / 1000)) }));
      }
      if (query.includes("InsuranceFund")) data.InsuranceFund = [{ fundedToken: "1000000000", coveredToken: "1232864" }];
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
      res.end(JSON.stringify({ data }));
    });
  })
  .listen(port, () => console.log(`indexer stub on :${port}`));
