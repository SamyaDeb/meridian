// Account mapping on the recorded K3 hedge account (packages/core/fixtures/perpl/chain/account-10143-k3-hedge.json,
// exchange views at the K3 run) and a Meridian AccountView.
import { mapMeridian, mapPerpl } from "../../features/trade/data/accounts";

const WAD = 10n ** 18n;
const P = { exchange: "0x1964c32f0be608e7d29302aff5e61268e72080cc" as const, perpId: 64n, priceDecimals: 5, lotDecimals: 0, collateralDecimals: 6 };

it("Perpl: free = balance − locked (CNS → WAD), the position risk from Perpl's own rule", () => {
  const acc = { accountId: 969n, balanceCNS: 4977468132n, lockedBalanceCNS: 0n };
  const pos = [{ positionType: 0, depositCNS: 22508666n, pricePNS: 2587n, priceResiduePNSQ16: 35288n, lotLNS: 2600n, deltaPnlCNS: -1469999n, premiumPnlCNS: -10530n }, 2530n] as const;
  const a = mapPerpl(acc, pos, 500n, P)!;
  expect(a.freeWad).toBe(4977468132n * 10n ** 12n);
  expect(a.position!.side).toBe("Long");
  expect(a.position!.sizeWad).toBe(2600n * WAD);
  expect(a.position!.markWad).toBe(2530n * 10n ** 13n);
  expect(a.position!.liqPriceWad).toBeGreaterThan(0n);
  expect(a.position!.liqPriceWad < a.position!.markWad).toBe(true);
  expect(a.position!.unrealizedPnlWad).toBe((-1469999n - 10530n) * 10n ** 12n);
});

it("Perpl: no account ⇒ null; flat account ⇒ no position", () => {
  expect(mapPerpl({ accountId: 0n, balanceCNS: 0n, lockedBalanceCNS: 0n }, undefined, 500n, P)).toBeNull();
  const flat = mapPerpl({ accountId: 5n, balanceCNS: 10n, lockedBalanceCNS: 20n }, undefined, 500n, P)!;
  expect(flat.position).toBeUndefined();
  expect(flat.freeWad).toBe(0n); // locked above balance never shows negative free collateral
});

it("Meridian: free = equity − IM − reserved, floored at 0", () => {
  const m = mapMeridian({ collateral: 100n * WAD, size: 300n * WAD, entryPrice: 25864n * 10n ** 12n, unrealizedPnl: -WAD, pendingFunding: 0n, equity: 99n * WAD, initialMargin: 2n * WAD, maintenanceMargin: WAD, reservedOrderMargin: WAD, liquidationPrice: 1n });
  expect(m.freeWad).toBe(96n * WAD);
  expect(mapMeridian({ collateral: 0n, size: 0n, entryPrice: 0n, unrealizedPnl: 0n, pendingFunding: 0n, equity: WAD, initialMargin: 2n * WAD, maintenanceMargin: 0n, reservedOrderMargin: 0n, liquidationPrice: 0n }).freeWad).toBe(0n);
});
