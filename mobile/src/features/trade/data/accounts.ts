// The unlocked wallet's positions and collateral on both venues, re-read per block while the Trade screen is open
// (one multicall, one read in flight). Meridian: ClearingHouse.getAccount (abis/ClearingHouse.json AccountView, WAD).
// Perpl: getAccountByAddr (free = balance − locked, CNS = AUSD 6 dp), getPositionV2(perpId, accountId) → core
// perplPositionRisk (Perpl's own liquidation rule), getMarginFractions(perpId, 0) once (init / maint hdths).
import { clearingHouseAbi } from "@meridian/core/meridian";
import { perplExchangeAbi } from "@meridian/core/perpl";
import { perplPositionRisk, type PerplPositionRisk } from "@meridian/core/route";
import type { Address, PublicClient } from "viem";
import { errText } from "../../../live/blockStore";
import { Store } from "../../../live/store";

export type MeridianAccount = {
  collateralWad: bigint;
  sizeWad: bigint;
  entryWad: bigint;
  upnlWad: bigint;
  pendingFundingWad: bigint;
  equityWad: bigint;
  /** equity − initial margin − reserved order margin, floored at 0 */
  freeWad: bigint;
  /** the contract's own liquidation price (0 = none) */
  liqWad: bigint;
  maintenanceWad: bigint;
};

export type PerplAccount = {
  accountId: bigint;
  freeWad: bigint;
  position: PerplPositionRisk | undefined;
};

export type AccountsState = {
  atBlock: bigint | undefined;
  meridian: MeridianAccount | undefined;
  /** null = no Perpl exchange account yet (getAccountByAddr id 0 / reverts) */
  perpl: PerplAccount | null | undefined;
  perplMargins: { initHdths: bigint; maintHdths: bigint } | undefined;
  error: string | undefined;
};

export type AccountsDeps = {
  client: Pick<PublicClient, "multicall">;
  address: Address;
  meridian: { clearingHouse: Address } | undefined;
  perpl: { exchange: Address; perpId: bigint; priceDecimals: number; lotDecimals: number; collateralDecimals: number } | undefined;
};

const ZERO = 0n;

export function mapMeridian(a: { collateral: bigint; size: bigint; entryPrice: bigint; unrealizedPnl: bigint; pendingFunding: bigint; equity: bigint; initialMargin: bigint; maintenanceMargin: bigint; reservedOrderMargin: bigint; liquidationPrice: bigint }): MeridianAccount {
  const free = a.equity - BigInt(a.initialMargin) - BigInt(a.reservedOrderMargin);
  return { collateralWad: a.collateral, sizeWad: a.size, entryWad: a.entryPrice, upnlWad: a.unrealizedPnl, pendingFundingWad: a.pendingFunding, equityWad: a.equity, freeWad: free > ZERO ? free : ZERO, liqWad: a.liquidationPrice, maintenanceWad: a.maintenanceMargin };
}

type PositionInfo = { positionType: number; depositCNS: bigint; pricePNS: bigint; priceResiduePNSQ16: bigint; lotLNS: bigint; deltaPnlCNS: bigint; premiumPnlCNS: bigint };

export function mapPerpl(acc: { accountId: bigint; balanceCNS: bigint; lockedBalanceCNS: bigint }, pos: readonly [PositionInfo, bigint, ...unknown[]] | undefined, maintHdths: bigint | undefined, p: NonNullable<AccountsDeps["perpl"]>): PerplAccount | null {
  if (acc.accountId === ZERO) return null;
  const scale = 10n ** BigInt(18 - p.collateralDecimals);
  const free = acc.balanceCNS - acc.lockedBalanceCNS;
  let position: PerplPositionRisk | undefined;
  if (pos && pos[0].lotLNS > ZERO && maintHdths !== undefined && maintHdths > ZERO) {
    position = perplPositionRisk(pos[0], pos[1], { priceDecimals: p.priceDecimals, lotDecimals: p.lotDecimals, maintMarginHdths: maintHdths });
  }
  return { accountId: acc.accountId, freeWad: (free > ZERO ? free : ZERO) * scale, position };
}

export class AccountsReader {
  readonly store = new Store<AccountsState>({ atBlock: undefined, meridian: undefined, perpl: undefined, perplMargins: undefined, error: undefined });
  private inFlight = false;

  constructor(private readonly d: AccountsDeps) {}

  onBlock(block: bigint): Promise<void> | undefined {
    const s = this.store.get();
    if (this.inFlight || (s.atBlock !== undefined && block <= s.atBlock)) return undefined;
    this.inFlight = true;
    return this.read(block).finally(() => {
      this.inFlight = false;
    });
  }

  /** after a trade: read on the next block even if one is in flight now */
  invalidate(): void {
    this.store.update({ atBlock: undefined });
  }

  private async read(block: bigint): Promise<void> {
    const { client, address, meridian, perpl } = this.d;
    try {
      if (perpl && !this.store.get().perplMargins) {
        const [mf] = await client.multicall({ allowFailure: true, contracts: [{ address: perpl.exchange, abi: perplExchangeAbi, functionName: "getMarginFractions", args: [perpl.perpId, 0n] }] });
        if (mf?.status === "success") {
          const r = mf.result as readonly bigint[];
          this.store.update({ perplMargins: { initHdths: r[0]!, maintHdths: r[1]! } });
        }
      }
      const contracts = [
        ...(meridian ? [{ address: meridian.clearingHouse, abi: clearingHouseAbi, functionName: "getAccount", args: [address] } as const] : []),
        ...(perpl ? [{ address: perpl.exchange, abi: perplExchangeAbi, functionName: "getAccountByAddr", args: [address] } as const] : []),
      ];
      type R = { status: "success"; result: unknown } | { status: "failure"; error: unknown };
      const res = (await client.multicall({ allowFailure: true, contracts: contracts as never })) as unknown as R[];
      let i = 0;
      const patch: Partial<AccountsState> = { atBlock: block, error: undefined };
      if (meridian) {
        const r = res[i++]!;
        if (r.status === "success") patch.meridian = mapMeridian(r.result as never);
        else patch.error = errText(r.error);
      }
      if (perpl) {
        const r = res[i++]!;
        if (r.status !== "success") patch.perpl = null; // the view reverts for a wallet with no exchange account
        else {
          const acc = r.result as { accountId: bigint; balanceCNS: bigint; lockedBalanceCNS: bigint };
          let pos: readonly [PositionInfo, bigint] | undefined;
          if (acc.accountId > ZERO) {
            const [p] = await client.multicall({ allowFailure: true, contracts: [{ address: perpl.exchange, abi: perplExchangeAbi, functionName: "getPositionV2", args: [perpl.perpId, acc.accountId] }] });
            if (p?.status === "success") pos = p.result as unknown as readonly [PositionInfo, bigint];
          }
          patch.perpl = mapPerpl(acc, pos, this.store.get().perplMargins?.maintHdths, perpl);
        }
      }
      this.store.update(patch);
    } catch (e) {
      this.store.update({ error: errText(e) });
    }
  }
}
