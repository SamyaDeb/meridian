// Server-rendered markup checks for every design-system component (roles, ARIA, token classes, states).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, Card, Chip, DataTable, Dialog, EmptyState, Notice, NumberCell, PillTabs, Skeleton, Tooltip } from ".";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Card", () => {
  it("is a rounded 24 px card with the hairline and title", () => {
    const h = html(<Card title="Order book">x</Card>);
    expect(h).toContain("rounded-card");
    expect(h).toContain("border-border");
    expect(h).toContain("<h2");
    expect(h).toContain("Order book");
  });
  it("inner variant is a 16 px well; scroll makes the body scroll inside", () => {
    expect(html(<Card variant="inner">x</Card>)).toContain("rounded-inner");
    expect(html(<Card scroll>x</Card>)).toContain("overflow-auto");
    expect(html(<Card scroll>x</Card>)).toContain('tabindex="0"');
    expect(html(<Card>x</Card>)).not.toContain("tabindex");
  });
  it("custom header replaces the title row", () => {
    const h = html(<Card header={<span>tabs</span>}>x</Card>);
    expect(h).toContain("tabs");
    expect(h).not.toContain("<h2");
  });
});

describe("Button", () => {
  it("defaults to type=button and a 44 px target at md", () => {
    const h = html(<Button>Go</Button>);
    expect(h).toContain('type="button"');
    expect(h).toContain("min-h-11");
  });
  it("brand / long / short use dark on-brand text (AA)", () => {
    for (const v of ["brand", "long", "short"] as const) expect(html(<Button variant={v}>x</Button>)).toContain("text-on-brand");
  });
  it("loading disables and marks busy", () => {
    const h = html(<Button loading>Place</Button>);
    expect(h).toContain("disabled");
    expect(h).toContain('aria-busy="true"');
  });
  it("sm grows to 44 px on coarse pointers", () => {
    expect(html(<Button size="sm">x</Button>)).toContain("pointer-coarse:min-h-11");
  });
});

describe("Chip", () => {
  it("tones map to tokens; violet only for brand", () => {
    expect(html(<Chip tone="brand">Monad</Chip>)).toContain("text-brand-soft");
    expect(html(<Chip tone="long">Long</Chip>)).toContain("text-long");
    expect(html(<Chip tone="warn">stale</Chip>)).toContain("text-warn");
    expect(html(<Chip>x</Chip>)).toContain("rounded-full");
  });
  it("pulse dot is decorative", () => {
    const h = html(<Chip dot pulse>live</Chip>);
    expect(h).toContain('aria-hidden="true"');
    expect(h).toContain("animate-ping");
  });
});

describe("PillTabs", () => {
  const tabs = [
    { id: "book", label: "Book" },
    { id: "trades", label: "Trades", count: 12 },
  ] as const;
  it("is a tablist with one selected, roving tabindex and counts", () => {
    const h = html(<PillTabs tabs={tabs} value="trades" onChange={() => {}} ariaLabel="Book view" />);
    expect(h).toContain('role="tablist"');
    expect(h).toContain('aria-label="Book view"');
    expect(h.match(/role="tab"/g)).toHaveLength(2);
    expect(h.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(h.match(/tabindex="0"/g)).toHaveLength(1);
    expect(h).toContain(">12<");
    expect(h).toContain("bg-brand");
  });
  it("links panels when a prefix is given", () => {
    expect(html(<PillTabs tabs={tabs} value="book" onChange={() => {}} ariaLabel="x" panelIdPrefix="p" />)).toContain('aria-controls="p-book"');
  });
});

describe("DataTable", () => {
  type R = { id: number; px: string };
  const cols = [
    { key: "id", header: "Id", cell: (r: R) => r.id },
    { key: "px", header: "Price", cell: (r: R) => r.px, align: "right" as const },
  ];
  const rows = (n: number): R[] => Array.from({ length: n }, (_, i) => ({ id: i, px: `p${i}` }));
  it("renders ARIA table roles with a sticky header", () => {
    const h = html(<DataTable columns={cols} rows={rows(3)} rowKey={(r) => String(r.id)} caption="Fills" />);
    expect(h).toContain('role="table"');
    expect(h).toContain('aria-label="Fills"');
    expect(h.match(/role="columnheader"/g)).toHaveLength(2);
    expect(h.match(/role="row"/g)).toHaveLength(4);
    expect(h).toContain("sticky top-0");
    expect(h).toContain('tabindex="0"'); // keyboard can scroll it
  });
  it("mounts every row up to the threshold and only a window above it", () => {
    const small = html(<DataTable columns={cols} rows={rows(100)} rowKey={(r) => String(r.id)} caption="x" />);
    expect(small.match(/role="row"/g)).toHaveLength(101);
    const big = html(<DataTable columns={cols} rows={rows(5_000)} rowKey={(r) => String(r.id)} caption="x" rowHeight={36} maxHeight={360} />);
    const mounted = (big.match(/role="row"/g) ?? []).length - 1;
    expect(mounted).toBeLessThan(40);
    expect(big).toContain('aria-rowcount="5001"');
  });
  it("shows the empty state for [] and a busy table while loading", () => {
    expect(html(<DataTable columns={cols} rows={[]} rowKey={(r) => String(r.id)} caption="x" empty={<p>No fills yet</p>} />)).toContain("No fills yet");
    expect(html(<DataTable columns={cols} rows={undefined} rowKey={(r) => String(r.id)} caption="x" />)).toContain('aria-busy="true"');
  });
});

describe("Dialog", () => {
  it("is a native dialog labelled by its title; body only rendered when open", () => {
    const closed = html(<Dialog open={false} onClose={() => {}} title="Deposit">body</Dialog>);
    expect(closed).toContain("<dialog");
    expect(closed).not.toContain("body");
    const open = html(<Dialog open onClose={() => {}} title="Deposit" footer={<button>OK</button>}>body</Dialog>);
    expect(open).toContain("aria-labelledby");
    expect(open).toContain('aria-label="Close"');
    expect(open).toContain("rounded-t-card");
  });
});

describe("Tooltip", () => {
  it("describes a focusable trigger", () => {
    const h = html(<Tooltip content="Funding is paid every block">i</Tooltip>);
    const id = /role="tooltip" id="([^"]+)"/.exec(h)?.[1];
    expect(id).toBeTruthy();
    expect(h).toContain(`aria-describedby="${id}"`);
    expect(h).toContain('tabindex="0"');
  });
});

describe("Notice / EmptyState / Skeleton", () => {
  it("notice is a status region, danger is an alert", () => {
    expect(html(<Notice tone="warn" title="Test market">x</Notice>)).toContain('role="status"');
    expect(html(<Notice tone="danger">x</Notice>)).toContain('role="alert"');
    expect(html(<Notice>x</Notice>)).toContain("rounded-inner");
  });
  it("empty state shows title, body and action", () => {
    const h = html(<EmptyState title="No positions" body="Open one from the ticket." action={<a href="/trade">Trade</a>} />);
    expect(h).toContain("No positions");
    expect(h).toContain("Open one from the ticket.");
    expect(h).toContain('href="/trade"');
  });
  it("skeleton announces loading", () => {
    expect(html(<Skeleton />)).toContain('aria-label="Loading"');
  });
});

describe("NumberCell", () => {
  const fmt = (v: bigint) => v.toString();
  it("signed values carry a glyph and a direction colour", () => {
    expect(html(<NumberCell value={5n} format={fmt} signed />)).toContain("+5");
    const neg = html(<NumberCell value={-5n} format={fmt} signed />);
    expect(neg).toContain("−5");
    expect(neg).toContain("text-short");
  });
  it("unsigned values are neutral; undefined is a dash", () => {
    expect(html(<NumberCell value={-5n} format={fmt} />)).toContain("-5");
    expect(html(<NumberCell value={undefined} format={fmt} />)).toContain("—");
  });
  it("a value that displays as zero is neutral, unsigned", () => {
    const h = html(<NumberCell value={-1n} format={(v) => (v / 100n).toString() + ".00"} signed />);
    expect(h).toContain(">0.00");
    expect(h).not.toContain("text-short");
    expect(h).not.toContain("−");
  });
  it("no flash on first render", () => {
    expect(html(<NumberCell value={5n} format={fmt} />)).not.toMatch(/tick-(up|down)/);
  });
});
