// Insurance-fund waterfall helpers shared by the perp and swap handlers (K2.1, InsuranceFundEvent).
import { type Ctx, evId, blockOf, tsOf, getInsuranceFund, insuranceFundAddress } from "./common.js";
import { AUSD_TO_WAD } from "./math.js";

type Located = {
  readonly srcAddress: string;
  readonly logIndex: number;
  readonly block: { readonly number: number; readonly timestamp: number };
  readonly transaction: { readonly hash: string };
};

/** InsuranceFundEvent PenaltyIn for a liquidation's toInsurance (WAD); shared with SwapLiquidated. */
export async function recordPenaltyIn(context: Ctx, event: Located, kind: "Perp" | "Swap", account: string, toInsuranceWad: bigint) {
  const fund = insuranceFundAddress(context);
  const amountToken = toInsuranceWad / AUSD_TO_WAD; // rounds down, as _payInsurance transfers
  if (!fund || amountToken === 0n) return;
  const f = await getInsuranceFund(context, fund);
  const balanceToken = f.balanceToken + amountToken;
  context.InsuranceFund.set({ ...f, penaltyToken: f.penaltyToken + amountToken, balanceToken });
  context.InsuranceFundEvent.set({
    id: `${evId(event)}-0`,
    fund,
    flow: "PenaltyIn",
    direction: "In",
    kind,
    market: event.srcAddress,
    account,
    from: undefined,
    amountWad: amountToken * AUSD_TO_WAD,
    amountToken,
    requestedWad: undefined,
    balanceAfterToken: balanceToken,
    block: blockOf(event),
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
}
