# CHANGE_REQUESTS — interface change log

Interfaces in `contracts/src/interfaces/` are frozen (tag `interfaces-v1`). To change one:
1. Append a CR below (next id). Keep building against the current interface/mock.
2. A WS-00 session reviews it, applies it (interface + mocks + regenerated `docs/INTERFACES.md`), bumps the tag (`interfaces-v1.1`), and marks it `Applied`.
3. Affected WS sessions rebase.

Rules: additive changes (new view, new event) are fast-tracked. Breaking changes need every affected WS listed and acknowledged. Never edit an interface on a feature branch.

| CR | Date | Requester | Interface | Change | Reason | Affected WS | Breaking? | Status |
|---|---|---|---|---|---|---|---|---|
| CR-000 | 2026-09-29 | planning | all | Initial freeze `interfaces-v1` | — | all | — | Applied |
| CR-001 | 2026-09-29 | planning (verification) | `external/IKuruOrderBook` | Match the real Kuru ABI: `placeAndExecuteMarketBuy/Sell(uint96, uint256 minOut, bool, bool) payable returns (uint256)`; `bestBidAsk() returns (uint256,uint256)`; add `getMarketParams`, `getL2Book`, `Trade` event. Unit notes in NatSpec | docs.kuru.io is wrong; verified via kuru-sdk ABI + mainnet fork buy/sell (ARCHITECTURE R17) | WS-04, WS-05 | yes (external only, nothing built on it yet) | Applied |
| CR-002 | 2026-09-29 | planning (verification) | `IKuruHedger`, `IPulseVault` | (a) `buySpot(uint256 quoteInToken, uint256 minBaseOut, bytes calldata route)` and `sellSpot(uint256 baseIn, uint256 minQuoteOut, bytes calldata route)`: empty `route` ⇒ direct Kuru market order on the configured market; non-empty ⇒ `call` **only** to KuruFlowEntrypoint `0xb3e6…13cb` with the keeper-supplied calldata (from `ws.kuru.io/api/quote`), exact-amount approval reset to 0 after, output checked by balance delta ≥ minOut. (b) `IPulseVault.rebalanceWithRoute(bytes calldata spotRoute) returns (RebalanceReason)`, keeper-only; the vault computes minOut from the **oracle index ± maxSlippage**, never from the keeper. (c) Hedger wraps native MON → WMON before returning | Kuru MON/AUSD is dead and AUSD/USDC is thin (R19, R19b). Kuru Flow routes AUSD→MON at 0.34% for $10k (R19c) and keeps the spot leg on Kuru for the bounty | WS-03 (keeper passes route), WS-04 | yes (nothing built yet) | Applied 29 Sep (interfaces-v1.1) |
| CR-003 | 2026-09-29 | planning (final plan) | new `IMarginEngine`, `IFundingRateOracle`, `IFundingSwapMarket`; `IClearingHouse`, `IOrderBook`, `PulseTypes`; PT/YT moved to `interfaces/deferred/` | (a) OrderBook hooks extracted to `IMarginEngine` (CH and swap market both implement it; OB is instrument-agnostic). (b) `FundingState.cumIndexTime` (G) + `FundingUpdated` carries it. (c) `IFundingRateOracle` (checkpoint ring buffer, ΔF/ΔG averages) implemented by CH. (d) `IFundingSwapMarket` + `SwapParams/SwapPosition/SwapAccountView`. (e) `VaultParams` + `skewCapacity`, `entryHorizonSec`, `maxSliceAssets`; `IPulseVault.shortCapacity()`, `RebalanceReason.SkewCap`. (f) constants CHECKPOINT_*, SECONDS_PER_YEAR, SWAP_PRICE_OFFSET | Final plan: fixed-rate layer = funding swaps on our own book (Kuru listing is owner-only; PT/YT splits fixed-rate liquidity). Vault capacity tied to long skew | all | yes (nothing built yet) | Applied 29 Sep (interfaces-v1.1) |
| CR-004 | 2026-09-29 | WS-00 | `IOrderBook`, `IKuruHedger` | `forge fmt` only (line wrapping); ABI byte-identical (checked with `forge inspect … abi`). INTERFACES.md regenerated | CI runs `forge fmt --check`; the frozen files failed it | none | no | Applied 29 Sep (no tag bump: no ABI change) |
| CR-005 | 2026-09-29 | WS-03 | `IOracleAdapter` | add `error InvalidOracleParams();` (constructor/setter bounds: maxStaleness ∈ [1, 3600] s, maxDeviation ∈ (0, 10%]) | CLAUDE.md §3: custom errors live in the interface; adapter declares it locally until applied | WS-03 | no (additive) | Applied 29 Sep (interfaces-v1.2) |
| CR-006 | 2026-09-29 | WS-02 | `IClearingHouse`, `IMarketFactory` | add `error InvalidParams();` to both (CH: constructor/`setRiskParams`/`setFundingParams` hard bounds, zero addresses, self-liquidation; factory: zero address / CH not wired to the given book) | CLAUDE.md §3: custom errors live in the interface; `ClearingHouse` and `MarketFactory` declare it locally until applied | WS-02 (remove local declarations) | no (additive) | Applied 29 Sep (interfaces-v1.3) |

### Template
```
| CR-00X | YYYY-MM-DD | WS-0X | IFoo | add `function bar() external view returns (uint256)` | why | WS-0Y, WS-0Z | no | Proposed |
```
