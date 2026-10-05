"use client";
import { DataTable, EmptyState, type Column } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import { formatAusdToken, formatBaseWad, formatPriceWad } from "@/lib/format";
import { PERP_LOT_SIZE_WAD as LOT, PERP_TICK_SIZE_WAD as TICK } from "@/lib/units";
import type { TriggerView } from "./abi";
import { useTriggers } from "./useTriggers";

/** Triggers tab: open stop-loss / take-profit triggers with cancel (refunds the prepaid tip). */
export function TriggersTable() {
  const { client, triggers, refetch } = useTriggers();
  const tx = useTx();
  if (!client) return null;
  const cols: Column<TriggerView>[] = [
    { key: "k", header: "Type", cell: (t) => <span className={t.kind === "StopMarket" ? "text-warn" : "text-long"}>{t.kind === "StopMarket" ? "Stop-loss" : "Take-profit"}</span> },
    { key: "p", header: "Trigger", align: "right", cell: (t) => <span className="num">{formatPriceWad(t.triggerPriceWad)}</span> },
    { key: "w", header: "Worst", align: "right", cell: (t) => <span className="num">{formatPriceWad(BigInt(t.limitTick) * TICK)}</span> },
    { key: "s", header: "Size", align: "right", cell: (t) => <span className="num">{formatBaseWad(t.lots * LOT, 0)} MON</span> },
    { key: "e", header: "Expires", align: "right", cell: (t) => <span className="num text-muted">#{t.expiryBlock.toString()}</span> },
    { key: "tip", header: "Tip", align: "right", cell: (t) => <span className="num text-muted">{formatAusdToken(t.tipToken)}</span> },
    {
      key: "x",
      header: "",
      align: "right",
      width: "88px",
      cell: (t) => (
        <button
          type="button"
          disabled={!tx.ready || tx.busy}
          onClick={() =>
            tx.run(`cancel trigger #${t.id}${client.mode === "mock" ? " (mock, nothing sent)" : ""}`, async (p, w) => {
              const r = await client.cancel(p, w, t.id);
              void refetch();
              return r;
            })
          }
          className="h-7 rounded-full bg-short/15 px-3 text-[11px] text-short disabled:opacity-40 pointer-coarse:h-11"
        >
          Cancel
        </button>
      ),
    },
  ];
  return (
    <>
      {tx.status && <p className="num mb-1 break-all text-[11px] text-muted" data-testid="triggers-tx-status">{tx.status}</p>}
      <DataTable caption="Triggers" columns={cols} rows={triggers} rowKey={(t) => t.id.toString()} minWidth={620} empty={<EmptyState compact title="No triggers" body="Add a stop-loss or take-profit from the ticket. A stop is not liquidation protection." />} />
    </>
  );
}
