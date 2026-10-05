import { describe, expect, it } from "vitest";
import type { AccountSummary } from "@/data/types";
import { freeCollateralWad, health, marginRatioWad } from "./account";
import { WAD } from "./units";

const acct = (o: Partial<AccountSummary>): AccountSummary => ({
  collateral: 100n * WAD,
  size: 0n,
  entryPrice: 0n,
  unrealizedPnl: 0n,
  pendingFunding: 0n,
  equity: 100n * WAD,
  initialMargin: 0n,
  maintenanceMargin: 0n,
  reservedOrderMargin: 0n,
  liquidationPrice: 0n,
  liquidatable: false,
  ...o,
});

describe("account card math", () => {
  it("free collateral never negative", () => {
    expect(freeCollateralWad(acct({ initialMargin: 30n * WAD }))).toBe(70n * WAD);
    expect(freeCollateralWad(acct({ initialMargin: 300n * WAD }))).toBe(0n);
  });
  it("margin ratio rounds up and handles flat / non-positive equity", () => {
    expect(marginRatioWad(acct({ maintenanceMargin: WAD, equity: 3n * WAD }))).toBe(WAD / 3n + 1n);
    expect(marginRatioWad(acct({}))).toBe(0n);
    expect(marginRatioWad(acct({ maintenanceMargin: WAD, equity: 0n }))).toBeUndefined();
  });
  it("health bands at 50 % and 80 %", () => {
    expect(health(acct({ maintenanceMargin: 49n * WAD }))).toBe("safe");
    expect(health(acct({ maintenanceMargin: 50n * WAD }))).toBe("warn");
    expect(health(acct({ maintenanceMargin: 80n * WAD }))).toBe("danger");
    expect(health(acct({ liquidatable: true }))).toBe("danger");
    expect(health(acct({ maintenanceMargin: WAD, equity: -1n }))).toBe("danger");
  });
});
