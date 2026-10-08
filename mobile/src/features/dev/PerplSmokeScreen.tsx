// Dev only (N4 §4 trade smoke, reused by N5): IOC buy of the smallest MON size with a slippage-capped limit from the
// live book → outcome + fills (REST reconcile) → position → reduce-only IOC close → flat. Everything shown is what
// Perpl answered: order id, limit, fill price, fee, blocks. Not in release bundles (app/dev/perpl.tsx).
import { pnsToWad } from "@meridian/core/perpl";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLive } from "../../live/LiveProvider";
import { Store, useStore } from "../../live/store";
import type { PerplMarketState } from "../../live/perplMarket";
import { Button, Card, formatValue, haptic, Segmented, space, Text } from "../../ui";
import { SMALLEST_LNS } from "../../venues/perpl/amounts";
import { runIoc, type IocResult } from "../../venues/perpl/ioc";
import { usePerpl, usePerplSocket } from "../../venues/perpl/PerplProvider";
import { sleep } from "../../venues/perpl/runtime";
import type { TradingSocketState } from "../../venues/perpl/tradingSocket";
import { SocketLine } from "../perpl/PerplSettings";

const NONE = new Store<PerplMarketState | undefined>(undefined);
const selBid = (s: PerplMarketState | undefined) => s?.bestBidWad;
const selAsk = (s: PerplMarketState | undefined) => s?.bestAskWad;
const selNet = (s: TradingSocketState | undefined) => s?.netSize ?? 0;
const selAcct = (s: TradingSocketState | undefined) => s?.account;

const SLIPPAGE = { "50": { label: "0.5%", bps: 50n }, "100": { label: "1%", bps: 100n }, "300": { label: "3%", bps: 300n } } as const;
type Slip = keyof typeof SLIPPAGE;
const SLIP_OPTIONS = (Object.keys(SLIPPAGE) as Slip[]).map((k) => ({ value: k, label: SLIPPAGE[k].label }));

function describeResult(r: IocResult, priceDecimals: number): string {
  const lines = [
    `phase ${r.state.phase}${r.error ? ` · ${r.error}` : ""}`,
    `rq ${r.rq ?? "—"} · order id ${r.orderId ?? "—"} · limit ${r.limitPns !== undefined ? formatValue(pnsToWad(r.limitPns, priceDecimals), "price", { dp: priceDecimals }) : "—"}`,
    `filled ${r.filledLns} lot(s) @ ${r.avgPriceWad !== undefined ? formatValue(r.avgPriceWad, "price", { dp: priceDecimals }) : "—"} · fee ${r.feeCns.toString()} (collateral units)`,
    ...r.fills.map((f) => `fill oid ${f.oid} · ${f.sizeLns} @ ${f.priceWad !== undefined ? formatValue(f.priceWad, "price", { dp: priceDecimals }) : "—"} · fee ${f.feeCns} · block ${f.block ?? "—"} · ${f.maker ? "maker" : "taker"}`),
  ];
  return lines.join("\n");
}

export default function PerplSmokeScreen() {
  const venue = usePerpl();
  const live = useLive();
  const mkt = (live.perpl?.store as Store<PerplMarketState | undefined> | undefined) ?? NONE;
  const bid = useStore(mkt, selBid);
  const ask = useStore(mkt, selAsk);
  const net = usePerplSocket(selNet);
  const acct = usePerplSocket(selAcct);
  const [slip, setSlip] = useState<Slip>("100");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const cfg = live.config;
  if (!venue || cfg.perpl.status !== "deployed") return <Text>Perpl isn't available (locked, or not configured on this chain).</Text>;
  const meta = cfg.perpl.deployment.markets[venue.marketId];
  if (!meta) return <Text>No market metadata for {venue.marketId} in deployments/perpl.json.</Text>;
  const market = { id: meta.id, priceDecimals: meta.priceDecimals, sizeDecimals: meta.sizeDecimals };

  const go = (side: "buy" | "sell", reduceOnly: boolean, sizeLns: number) => {
    const t = venue.socket.client;
    const rest = venue.onboarding.signedRest();
    if (!t || !rest) return setLog((l) => [...l, "Not ready: the trading socket is off (finish Perpl setup, stay in the foreground)."]);
    setBusy(true);
    setLog((l) => [...l, `${reduceOnly ? "close" : "open"} ${side} ${sizeLns} lot(s), slippage ${SLIPPAGE[slip].label}…`]);
    runIoc({ side, reduceOnly, sizeLns, slippageBps: SLIPPAGE[slip].bps, leverage: 100 }, { trading: t, rest, market, book: () => ({ bidWad: mkt.get()?.bestBidWad, askWad: mkt.get()?.bestAskWad }), sleep })
      .then(
        (r) => {
          r.state.phase === "DONE" ? haptic.success() : haptic.error();
          setLog((l) => [...l, describeResult(r, market.priceDecimals)]);
          return venue.refresh();
        },
        (e: unknown) => {
          haptic.error();
          setLog((l) => [...l, `error: ${e instanceof Error ? e.message : String(e)}`]);
        },
      )
      .finally(() => setBusy(false));
  };

  const free = acct ? BigInt(acct.b) - BigInt(acct.lb) : undefined;
  return (
    <View style={s.wrap}>
      <Card>
        <Text bold>Perpl market {market.id}</Text>
        <Text testID="smoke-book">
          bid {bid !== undefined ? formatValue(bid, "price", { dp: market.priceDecimals }) : "—"} · ask {ask !== undefined ? formatValue(ask, "price", { dp: market.priceDecimals }) : "—"}
        </Text>
        <SocketLine />
        <Text testID="smoke-position">
          position {net} lot(s) · account #{acct?.id ?? "—"} · free collateral {free !== undefined ? free.toString() : "—"} (collateral units)
        </Text>
        <Segmented options={SLIP_OPTIONS} value={slip} onChange={setSlip} accessibilityLabel="Slippage cap" />
        <Button title={`IOC buy ${SMALLEST_LNS} lot`} disabled={busy} onPress={() => go("buy", false, SMALLEST_LNS)} testID="btn-ioc-buy" />
        <Button title={`Close (reduce-only IOC ${net > 0 ? "sell" : "buy"} ${Math.abs(net)})`} variant="secondary" disabled={busy || net === 0} onPress={() => go(net > 0 ? "sell" : "buy", true, Math.abs(net))} testID="btn-ioc-close" />
      </Card>
      <Card>
        {log.length === 0 ? <Text tone="muted">No orders yet.</Text> : null}
        {log.map((x, i) => (
          <Text key={i} selectable variant="caption" testID={`smoke-log-${i}`}>
            {x}
          </Text>
        ))}
      </Card>
    </View>
  );
}

const s = StyleSheet.create({ wrap: { padding: space.l, gap: space.m } });
