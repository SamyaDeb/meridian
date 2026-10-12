"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Card, Chip, DataTable, Dialog, EmptyState, Notice, NumberCell, PillTabs, Skeleton, Tooltip, type Column } from "@/components/ds";
import { formatAusdWad, formatPriceWad } from "@/lib/format";
import { WAD } from "@/lib/units";

// Every component in every state, for review and screenshots. Sample values are labelled as samples: this page
// never reads protocol data.

type Row = { id: number; price: bigint; size: bigint; side: "long" | "short" };
const SAMPLE_ROWS: Row[] = Array.from({ length: 1_000 }, (_, i) => ({
  id: i,
  price: 3_000_000_000_000_000_000n + BigInt(i) * 10n ** 13n,
  size: BigInt((i % 17) + 1) * 100n * WAD,
  side: i % 3 === 0 ? "short" : "long",
}));
const COLUMNS: Column<Row>[] = [
  { key: "id", header: "#", cell: (r) => <span className="num text-muted">{r.id}</span>, width: "56px" },
  { key: "side", header: "Side", cell: (r) => <span className={r.side === "long" ? "text-long" : "text-short"}>{r.side === "long" ? "▲ Long" : "▼ Short"}</span> },
  { key: "price", header: "Price", cell: (r) => <span className="num">{formatPriceWad(r.price)}</span>, align: "right" },
  { key: "size", header: "Size (MON)", cell: (r) => <span className="num">{formatAusdWad(r.size)}</span>, align: "right" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card title={title} as="section">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </Card>
  );
}

export function Gallery() {
  const [tab, setTab] = useState<"book" | "trades" | "depth">("book");
  const [small, setSmall] = useState<"positions" | "orders" | "history">("positions");
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(3_012_345_000_000_000_000n);
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + (Math.random() > 0.5 ? 1n : -1n) * 10n ** 15n), 1_200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-2 py-2">
      <Notice tone="brand" title="Design system (dev only)">
        Sample values for layout review. Nothing on this page reads or sends protocol data.
      </Notice>

      <div className="grid gap-2 lg:grid-cols-2">
        <Section title="Button: variants">
          <Button variant="brand">Brand</Button>
          <Button variant="long">Long</Button>
          <Button variant="short">Short</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Cancel all</Button>
        </Section>
        <Section title="Button: sizes and states">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg" variant="brand">
            Large
          </Button>
          <Button loading variant="brand">
            Placing
          </Button>
          <Button disabled>Disabled</Button>
        </Section>
        <Section title="Chip">
          <Chip tone="brand" dot pulse>
            Monad
          </Chip>
          <Chip tone="warn">test market</Chip>
          <Chip tone="warn" dot>
            stale
          </Chip>
          <Chip tone="long">▲ long</Chip>
          <Chip tone="short">▼ short</Chip>
          <Chip>1h 10.95%</Chip>
        </Section>
        <Section title="PillTabs">
          <PillTabs ariaLabel="Book view" tabs={[{ id: "book", label: "Book" }, { id: "trades", label: "Trades" }, { id: "depth", label: "Depth" }]} value={tab} onChange={setTab} />
          <PillTabs
            size="sm"
            ariaLabel="Account tables"
            tabs={[
              { id: "positions", label: "Positions", count: 1 },
              { id: "orders", label: "Open orders", count: 3 },
              { id: "history", label: "History", disabled: true },
            ]}
            value={small}
            onChange={setSmall}
          />
        </Section>
        <Section title="NumberCell (sample tick every 1.2 s)">
          <span className="text-lg">
            <NumberCell value={tick} format={formatPriceWad} />
          </span>
          <NumberCell value={12_340_000_000_000_000_000n} format={formatAusdWad} signed suffix="AUSD" />
          <NumberCell value={-500_000_000_000_000_000n} format={formatAusdWad} signed suffix="AUSD" />
          <NumberCell value={undefined} format={formatAusdWad} />
        </Section>
        <Section title="Tooltip and Dialog">
          <Tooltip content="Funding settles every block (~300 ms).">
            <span className="text-sm text-muted underline decoration-dotted">What is per-block funding?</span>
          </Tooltip>
          <Button variant="brand" onClick={() => setOpen(true)}>
            Open dialog
          </Button>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Deposit AUSD"
            footer={
              <>
                <Button block onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button block variant="brand" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted">Dialog body. Esc, the backdrop and the close button all dismiss it.</p>
          </Dialog>
        </Section>
        <Section title="Skeleton">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-3 w-56" />
        </Section>
        <Card title="Notice">
          <div className="space-y-2">
            <Notice tone="info">Indexer not connected: history is unavailable.</Notice>
            <Notice tone="warn" title="Test market">
              Not counted in product stats.
            </Notice>
            <Notice tone="danger" title="Transaction reverted" action={<Button size="sm">Retry</Button>}>
              InsufficientMargin()
            </Notice>
          </div>
        </Card>
      </div>

      <div className="grid gap-2 lg:grid-cols-3">
        <Card title="DataTable: 1,000 sample rows (virtualised)" className="lg:col-span-2">
          <DataTable columns={COLUMNS} rows={SAMPLE_ROWS} rowKey={(r) => String(r.id)} caption="Sample rows" maxHeight={280} />
        </Card>
        <Card title="DataTable: empty and loading">
          <DataTable columns={COLUMNS} rows={[]} rowKey={(r) => String(r.id)} caption="Empty" empty={<EmptyState title="No open orders" body="Place a limit order from the ticket." />} />
          <DataTable columns={COLUMNS} rows={undefined} rowKey={(r) => String(r.id)} caption="Loading" />
        </Card>
      </div>

      <Card title="Radius and gap scale">
        <div className="flex flex-wrap items-end gap-2 text-[11px] text-muted">
          <div className="flex h-20 w-28 items-center justify-center rounded-card border border-border bg-card-2">card 14</div>
          <div className="flex h-16 w-24 items-center justify-center rounded-inner bg-card-2">inner 10</div>
          <div className="flex h-11 w-24 items-center justify-center rounded-control bg-card-2">control 8</div>
          <div className="flex h-8 w-20 items-center justify-center rounded-full bg-card-2">pill</div>
        </div>
      </Card>
    </div>
  );
}
