// N6 + N7: Earn runs in Activity. The log keeps an Earn entry per run (open / close / leftover close) next to N7's trade
// receipts: v1 entries written before still decode, unknown kinds are skipped; the executor logs each run once (a kill
// before the run record is cleared logs it again on resume under the same id: still one row); the row stands for its
// legs' Perpl fills (recorded K3 page) and sorts with them; tapping it opens the Earn receipt. No network.
jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn() } }));
import fillsRec from "../../../../packages/core/fixtures/perpl/testnet/trading/history-fills.json";
import { stringifyBig } from "@meridian/core/util";
import type { Fill } from "@meridian/core/perpl";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { ActivityList } from "../../features/activity/ActivityList";
import { ActivityFeed } from "../../features/activity/feed";
import { ActivityLog, activityLogKey, decodeLog, encodeLog } from "../../features/activity/log";
import { fromLog, mergeActivity, perplTrades, type LogEntry, type LoggedEarn, type LoggedReceipt } from "../../features/activity/model";
import { earnReceiptStore } from "../../features/earn/executor";
import { earnRecordStore } from "../../features/earn/record";
import type { EarnTimeline } from "../../features/earn/timeline";
import type { Receipt } from "../../features/trade/exec/receipt";
import { ALL, executor, ME, memKv, META, PLAN, WAD, world } from "../earn/execFixtures";

const mockRouter = (jest.requireMock("expo-router") as { router: { push: jest.Mock } }).router;
const FILLS = fillsRec.pages.flatMap((p) => p.d) as Fill[];
const MON = { id: 64, priceDecimals: 5, sizeDecimals: 0, collateralDecimals: 6 };

const receipt = (o: Partial<Receipt> = {}): Receipt => ({ ok: true, venue: "perpl", side: "long", reduceOnly: false, summary: "Long 600 MON on Perpl", filledWad: 600n * WAD, stepWad: WAD, avgPriceWad: 2585n * 10n ** 13n, priceDp: 5, feeWad: 5351n * 10n ** 12n, orderId: 4525855211536, txHash: undefined, explorerTxUrl: undefined, blocksToFill: 2n, error: undefined, ...o });
const TL: EarnTimeline = { kind: "open", phase: "DONE", outcome: "success", headline: "You're earning the gap", body: "Both legs filled.", steps: [{ key: "leg1", title: "Long 600 MON on Perpl", detail: "Filled 600 MON", status: "filled", orderId: 4525855211536 }] };
const earnEntry = (o: Partial<Extract<LoggedEarn["earn"], { run: "open" | "close" }>> = {}, atMs = 1791402966000): LoggedEarn => ({ kind: "earn", atMs, block: 69059071n, earn: { run: "open", runId: "e1", perplWad: 600n * WAD, meridianWad: 600n * WAD, lockWad: 0n, stepWad: WAD, timeline: TL, legIds: ["perpl-order-4525855211536", "meridian-tx-0xabc"], ...o } });

describe("log: Earn entries next to N7's receipts", () => {
  it("round trip: an Earn run (open / close / leftover) and a trade receipt, bigints intact", () => {
    const entries: LogEntry[] = [
      earnEntry(),
      earnEntry({ run: "close", runId: "c2", lockWad: 1_000n * WAD, timeline: { ...TL, kind: "close", phase: "CLOSED", headline: "Closed on both venues" } }),
      { kind: "earn", atMs: 3, block: undefined, earn: { run: "leftover", runId: "l3", receipt: receipt({ reduceOnly: true, orderId: 77 }) } },
      { atMs: 4, block: 5n, receipt: receipt({ orderId: 9 }) },
    ];
    expect(decodeLog(encodeLog(entries))).toEqual(entries);
  });

  it("v1 entries written before (N7: receipts only) still decode; unknown kinds and broken Earn entries are skipped, not thrown", () => {
    // exactly what N7's encodeLog wrote
    const n7 = stringifyBig({ v: 1, e: [{ atMs: 1, block: 7n, receipt: receipt({ orderId: 1 }) }] });
    expect((decodeLog(n7) as LoggedReceipt[]).map((e) => e.receipt.orderId)).toEqual([1]);
    const mixed = stringifyBig({ v: 1, e: [{ kind: "swap-v9", atMs: 1, whatever: true }, { kind: "earn", atMs: 2, earn: { run: "open", runId: "x" } }, { atMs: 3, block: undefined, receipt: receipt({ orderId: 3 }) }, earnEntry()] });
    expect(decodeLog(mixed).map((e) => ("kind" in e ? e.earn.runId : e.receipt.orderId))).toEqual([3, "e1"]);
  });

  it("the same run logged twice is one entry; a leftover close replaces that order's plain receipt", async () => {
    const { kv } = memKv();
    const log = new ActivityLog(kv, activityLogKey(10143, ME));
    await log.add(earnEntry({}, 1));
    await log.add({ atMs: 2, block: undefined, receipt: receipt({ orderId: 77, reduceOnly: true }) });
    await log.add(earnEntry({}, 3));
    await log.add({ kind: "earn", atMs: 4, block: undefined, earn: { run: "leftover", runId: "l4", receipt: receipt({ orderId: 77, reduceOnly: true }) } });
    expect(log.store.get().map((e) => ("kind" in e ? `${e.earn.run}:${e.atMs}` : `trade:${e.atMs}`))).toEqual(["leftover:4", "open:3"]);
    expect(fromLog(log.store.get()).map((i) => [i.id, i.title])).toEqual([
      ["perpl-order-77", "Earn leftover closed: 600 MON"],
      ["earn-e1", "Earn open · You're earning the gap"],
    ]);
  });
});

describe("executor → log: one row per run, even across a resume", () => {
  it("a kill after the run was logged but before its record was cleared ⇒ resume logs it again under the same id ⇒ one row", async () => {
    const w = world(ALL);
    const { kv } = memKv();
    const log = new ActivityLog(kv, activityLogKey(10143, ME));
    const onRun = (e: LoggedEarn["earn"]) => log.add({ kind: "earn", atMs: 1, block: undefined, earn: e });
    const runs = earnRecordStore(kv, 10143, ME);
    let killed = false;
    const dying = { ...runs, clear: async () => ((killed = true), Promise.reject(new Error("app killed"))) };
    await executor(() => w, kv, { runs: dying, onRun }).open(PLAN, META);
    expect(killed).toBe(true);
    expect(await runs.load()).toBeDefined(); // the terminal run is still stored
    expect(log.store.get()).toHaveLength(1);
    const t = await executor(() => w, kv, { onRun }).resume();
    expect(t!.phase).toBe("DONE");
    expect(await runs.load()).toBeUndefined();
    const rows = fromLog(log.store.get());
    expect(rows).toHaveLength(1);
    const e = log.store.get()[0] as LoggedEarn;
    expect(e.earn).toMatchObject({ run: "open", perplWad: 300n * WAD, meridianWad: 300n * WAD, stepWad: WAD });
    // its legs: the Perpl order and the Meridian tx, so the venue feeds' rows for them fold into this one
    expect(e.earn.run !== "leftover" && e.earn.legIds.some((i) => i.startsWith("perpl-order-")) && e.earn.legIds.some((i) => i.startsWith("meridian-tx-0x"))).toBe(true);
    expect(rows[0]!.title).toBe("Earn open · You're earning the gap");
    expect(rows[0]!.detail).toBe("Perpl 300 · Meridian 300 MON");
  });

  it("the live one-tap close isn't kept in history (a past MANUAL row can't place an order)", async () => {
    const w = world({ perplFill: (p) => (p.reduceOnly ? 0 : p.sizeLns), meridianFill: () => "revert" });
    const { kv } = memKv();
    const got: LoggedEarn["earn"][] = [];
    const t = await executor(() => w, kv, { onRun: (e) => void got.push(e) }).open(PLAN, META);
    expect(t!.leftover).toBeDefined();
    expect(got).toHaveLength(1);
    expect(got[0]!.run !== "leftover" && got[0]!.timeline.leftover).toBeUndefined();
  });

  it("the one-tap leftover close is logged with its receipt", async () => {
    const w = world(ALL);
    const { kv } = memKv();
    const got: LoggedEarn["earn"][] = [];
    await executor(() => w, kv, { onRun: (e) => void got.push(e) }).noteManualClose(300n * WAD, receipt({ orderId: 5, reduceOnly: true, filledWad: 300n * WAD }));
    expect(got).toEqual([{ run: "leftover", runId: expect.stringMatching(/^l/), receipt: expect.objectContaining({ orderId: 5 }) }]);
  });
});

describe("merge with Perpl fills (recorded K3 page)", () => {
  it("the Earn row stands for its Perpl leg's fills and sorts by time with the rest", () => {
    const perpl = perplTrades(FILLS, MON);
    expect(perpl.map((r) => r.id).sort()).toEqual(["perpl-order-4525679575056", "perpl-order-4525855211536"]);
    const earn = fromLog([earnEntry({}, 1791402966000)]);
    const merged = mergeActivity(earn, perpl);
    // order 4525855211536 is the Earn run's Perpl leg: listed once, as the Earn row; the other order stays
    expect(merged.map((r) => r.id)).toEqual(["earn-e1", "perpl-order-4525679575056"]);
    // an Earn run older than a fill sorts after it
    const older = mergeActivity(fromLog([earnEntry({ legIds: [] }, 1)]), perpl);
    expect(older.at(-1)!.id).toBe("earn-e1");
  });
});

it("RNTL: the Earn row reads its sizes and opens the Earn receipt with its timeline", async () => {
  const { kv } = memKv();
  const log = new ActivityLog(kv, activityLogKey(10143, ME));
  const feed = new ActivityFeed({ log, perpl: () => undefined, perplOff: () => "off", meridian: undefined, explorerBase: undefined });
  await log.add(earnEntry({}, Date.now() - 120_000));
  await render(<ActivityList store={feed.store} />);
  const row = screen.getByTestId("activity-earn-e1");
  expect(row).toHaveTextContent(/Earn open · You're earning the gap/);
  expect(row).toHaveTextContent(/Perpl 600 · Meridian 600 MON · Meridian \+ Perpl · 2 min ago/);
  expect(row.props.accessibilityHint).toBe("Opens the receipt");
  fireEvent.press(row);
  expect(earnReceiptStore.get()).toEqual(TL);
  expect(mockRouter.push).toHaveBeenCalledWith("/earn-receipt");
  earnReceiptStore.set(undefined);
});
