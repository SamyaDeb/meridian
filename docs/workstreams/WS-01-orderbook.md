# WS-01 — Order book and matching engine

**Founder:** A (Samya)

**Goal:** A fully onchain, **instrument-agnostic** CLOB (settles into any `IMarginEngine`; deployed twice: MON-PERP with tick 1e-6 AUSD / lot 100 MON, and the funding-swap book with price = 1 + APR, tick 1e-4 / lot 1,000 MON) with price-time priority, a tick ladder plus a 2-level bitmap, bounded matching, and synchronous settlement through the ClearingHouse hooks. MM place+cancel must stay under 100k gas.

## Owned paths
`contracts/src/orderbook/**`, `contracts/test/unit/OrderBook*.t.sol`, `contracts/test/fuzz/OrderBook*.t.sol`, `contracts/test/bench/OrderBookGas.t.sol`, `contracts/test/invariant/handlers/OrderBookHandler.sol`.

## Interfaces
Provides: `IOrderBook`. Consumes: `IMarginEngine` hooks (`reserveOrderMargin`, `releaseOrderMargin`, `settleMakerFill`, `settleTakerFill`); `PulseConstants`. Never import IClearingHouse. Build against `MockClearingHouse` until WS-02 merges. Protocol: INTERFACES §2.

## Task checklist (ordered)
1. [ ] Storage design doc-comment at the top of `OrderBook.sol` (MIP-8 verified, ARCHITECTURE R5: first write to a page costs 2,800, later writes to that page 0, each new nonzero slot 17,000, no refunds ⇒ **recycle order slots via a free-list, never zero them**): header slot(s), `levels` layout (array indexed by tick for MIP-8 page locality, ARCHITECTURE §3), 1-slot `Order {maker160|lots64|next32}`, FIFO via head/tail per level, 2-level bitmap (`uint256` summary word + `mapping(uint256=>uint256)` words).
2. [ ] `libraries/TickBitmap.sol`: set/clear/nextBelow/nextAbove. Fuzz against a naive reference.
3. [ ] `placeLimitOrder` rest path (no cross) + `reserveOrderMargin` + events. Validate tick range, `lots > 0`, open-order cap 64.
4. [ ] `cancelOrder`, `cancelOrders` (≤ 32), with release. Lazy unlink is OK if level totals stay exact.
5. [ ] Matching loop (≤ 32 fills): maker settlement, eviction on `false`, `Trade` event per fill, taker aggregation, `settleTakerFill` last. `lastTrade` update.
6. [ ] `placeMarketOrder` (IOC at limitTick, minFilledLots), flags POST_ONLY / IOC / REDUCE_ONLY on limit orders.
7. [ ] `replaceOrder` (cancel+place fast path, same slot reuse where possible).
8. [ ] Views: bestBid/bestAsk/midPrice/lastTrade/getOrder/getLevel/getDepth(≤ 32)/openOrderCount.
9. [ ] `nonReentrant` (transient) on all mutating entrypoints; `Paused` via CH or local owner flag.
10. [ ] Gas pass + `OrderBookGas.t.sol` producing the numbers for BENCHMARKS B1 (write CSV to `bench-out/`).
11. [ ] `OrderBookHandler` for WS-08 invariants (I6, I7).

## Acceptance criteria
- Price-time priority proven by tests (same tick FIFO; better price first).
- No loop without a constant bound; matching stops at 32 fills and leaves the remainder resting (limit) or unfilled (IOC).
- Gas (Foundry, warm book, existing level): place ≤ 60k, cancel ≤ 35k, place+cancel cycle **< 100k**; each extra fill ≤ 30k excluding CH cost. Report the actual numbers.
- `bestBid < bestAsk` always when both exist.
- Works unmodified against the real ClearingHouse at CP1.

## Required tests
Unit: every function + revert. Fuzz: random sequences of place/cancel/market vs. a Solidity reference model (sorted arrays) comparing best prices, level totals and fills. Invariant handler: I6 book integrity, I7 reservation sums. Gas bench.

## Out of scope
Margin math, fees, funding (WS-02); stop orders; cross-market routing; offchain matching.

## Day budget
D1 design + bitmap · D2 place/cancel · D3 matching + hooks · D4 gas pass · D5 CP1 · D6 replace/IOC/post-only · D7 fuzz · D8 bench hooks · D9 CP2 · D10–13 fixes.

## Kickoff prompt
```
You are the engineer for WS-01 (Order book and matching engine) of Pulse.
Read CLAUDE.md, docs/TEAM_PLAN.md, docs/PRD.md, docs/ARCHITECTURE.md (§0 R5, §2.1, §2.2, §3, §4), docs/MATH_SPEC.md, docs/INTERFACES.md and docs/workstreams/WS-01-orderbook.md.
Work only in your owned paths on branch ws-01-orderbook (branch from main after tag interfaces-v1.1).
Implement contracts/src/orderbook/OrderBook.sol implementing IOrderBook exactly and settling only through IMarginEngine; build and test against MockClearingHouse.
Tests first: write the TickBitmap fuzz test and the price-time priority unit tests before the implementation.
No unbounded loops; respect PulseConstants bounds. Report gas numbers for place, cancel, replace and k-fill matches at the end.
If you need an interface change, add a CR to docs/CHANGE_REQUESTS.md and continue against the current interface.
```
