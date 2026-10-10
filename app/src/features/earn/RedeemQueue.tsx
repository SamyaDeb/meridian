"use client";
// Earn v2 (K6 B1, CR-014): my withdrawal requests. Status and payout are live from the chain; a pending request's
// payout is only an estimate at the current share price (it is priced when the keeper fulfils it, minus the 5 bps fee
// and that batch's unwind cost). Cancel = owner + pending; Claim = fulfilled (pays the receiver).
import { Button, Card, Chip, Skeleton } from "@/components/ds";
import type { Address } from "@/data/types";
import { formatAusdToken, formatFixed } from "@/lib/format";
import { estimateRedeemToken, queuePosition, redeemActions, type RedeemRow, type RedeemStatusName } from "@/lib/redeem";

const LABEL: Record<RedeemStatusName, string> = { requested: "Requested", claimable: "Fulfilled · claim", claimed: "Claimed", cancelled: "Cancelled" };
const TONE: Record<RedeemStatusName, "warn" | "long" | "neutral"> = { requested: "warn", claimable: "long", claimed: "neutral", cancelled: "neutral" };

export function RedeemQueue(props: {
  rows: RedeemRow[];
  pendingIds: bigint[];
  queueComplete: boolean;
  sharePriceWad: bigint | undefined;
  me: Address | undefined;
  loading: boolean;
  busy: boolean;
  block: bigint | undefined;
  onCancel: (id: bigint) => void;
  onClaim: (id: bigint) => void;
}) {
  const { rows, pendingIds } = props;
  if (!props.loading && rows.length === 0) return null;
  const queueLen = new Set(pendingIds).size;
  return (
    <Card title="Your withdrawal requests" className="h-fit" right={props.block !== undefined ? <span className="text-[11px] text-muted">block {props.block.toString()}</span> : undefined}>
      {props.loading && rows.length === 0 ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <ul className="divide-y divide-border" data-testid="redeem-requests">
          {rows.map((r) => {
            const a = redeemActions(r, props.me);
            const pos = r.status === "requested" ? queuePosition(r.id, pendingIds) : undefined;
            const est = r.status === "requested" && props.sharePriceWad !== undefined ? estimateRedeemToken(r.shares, props.sharePriceWad) : undefined;
            return (
              <li key={r.id.toString()} className="py-2" data-testid={`redeem-${r.id}`} data-status={r.status}>
                <div className="flex items-center justify-between gap-2">
                  <span className="num text-sm">#{r.id.toString()}</span>
                  <Chip tone={TONE[r.status]} dot>
                    {LABEL[r.status]}
                  </Chip>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-3 text-xs text-muted">
                  <span>Shares</span>
                  <span className="num text-right text-text">{formatFixed(r.shares, 18, 4)}</span>
                  {pos !== undefined && (
                    <>
                      <span>Place in queue</span>
                      <span className="num text-right text-text" data-testid="queue-position">
                        {pos} of {queueLen}
                        {props.queueComplete ? "" : " (recent window)"}
                      </span>
                    </>
                  )}
                  {est !== undefined && (
                    <>
                      <span>Estimate now</span>
                      <span className="num text-right text-text" data-testid="redeem-estimate">
                        ≈ {formatAusdToken(est)} AUSD
                      </span>
                    </>
                  )}
                  {r.assets !== undefined && (r.status === "claimable" || r.status === "claimed") && (
                    <>
                      <span>{r.status === "claimed" ? "Paid" : "Payout (fixed)"}</span>
                      <span className="num text-right text-text" data-testid="redeem-assets">
                        {formatAusdToken(r.assets)} AUSD
                      </span>
                    </>
                  )}
                  {r.unwindCost !== undefined && r.unwindCost > 0n && (
                    <>
                      <span>Unwind cost (yours)</span>
                      <span className="num text-right text-text">{formatAusdToken(r.unwindCost)} AUSD</span>
                    </>
                  )}
                </div>
                {est !== undefined && (
                  <p className="mt-1 text-[11px] text-muted">Estimate at the current share price after the 5 bps fee. The payout is fixed when the keeper fulfils it and also pays its share of any unwind cost.</p>
                )}
                {(a.cancel || a.claim) && (
                  <div className="mt-2 flex gap-2">
                    {a.cancel && (
                      <Button size="sm" disabled={props.busy} onClick={() => props.onCancel(r.id)} data-testid={`cancel-${r.id}`}>
                        Cancel
                      </Button>
                    )}
                    {a.claim && (
                      <Button size="sm" variant="brand" disabled={props.busy} onClick={() => props.onClaim(r.id)} data-testid={`claim-${r.id}`}>
                        Claim {r.assets !== undefined ? `${formatAusdToken(r.assets)} AUSD` : ""}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
