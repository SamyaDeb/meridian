# ARCHITECTURE — Pulse

Status: v1.1 (interfaces-v1.1: CR-001..003 applied 29 Sep). Changes go through `docs/CHANGE_REQUESTS.md`.

## 0. Research findings (verified 2026-09-29, second pass: onchain reads, mainnet fork tests, official docs)

| # | Fact | Value | Source / method | Status |
|---|---|---|---|---|
| R1 | Monad chain ids | mainnet 143, testnet 10143 | Monad docs; `cast chain-id` | ✅ |
| R2 | Public mainnet RPCs | `rpc.monad.xyz` (25 rps), `rpc1` (15 rps), `rpc2`, `rpc3`, `rpc-mainnet.monadinfra.com` | Monad docs | ✅ **`eth_getLogs` is capped at 100 blocks on the public RPCs** ⇒ indexer uses HyperSync, keepers use a paid RPC |
| R3 | Block time | 300 ms (MIP-12); finality 600 ms | Monad blog | ✅ |
| R4 | `block.timestamp` resolution | whole seconds; ~3 blocks share a timestamp | 8 consecutive mainnet blocks via `cast block` | ✅ ⇒ block-number Δt (MATH_SPEC §1.1) |
| R5 | MIP-8 gas schedule (status **Final**, live since 2 Sep) | page = `slot >> 7` (128 slots). SLOAD: cold page 8,100, warm page 100. SSTORE: base 100 + page load 8,000 if not cached + **2,800 on the first write to a page per tx (later writes to the same page: 0)** + 17,000 per zero→nonzero slot; nonzero→nonzero and →zero: 0; **no refunds** | mips.monad.xyz/MIPs/MIP-8 | ✅ ⇒ reuse slots (never delete/re-create orders, recycle order slots), cluster hot writes in one page; `mapping(address => Struct)` preferred over parallel mappings |
| R6 | Gas billed on gas limit | yes | Monad docs | ✅ |
| R7 | Max contract size | 128 KB code / 256 KB initcode | Monad docs | ✅ |
| R8 | EVM version | Cancun opcodes supported (we compile `cancun`). Probe of precompile 0x0b reverted (consistent with Prague BLS precompile present) | docs + eth_call | ✅ Cancun; Prague not needed |
| R9 | AUSD | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 dp, name "Agora Dollar", EIP-712 domain version "1", **EIP-2612 `permit` works** (fork test: permit → allowance set) | onchain + fork test | ✅ one-signature deposit possible |
| R10 | WMON | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` | Monad docs | ✅ |
| R10b | USDC (Kuru quote) | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, 6 dp | Kuru market params + onchain `symbol()` | ✅ |
| R11 | Chainlink push feeds | MON/USD `0xBcD78f76005B7515837af6b50c7C52BCf73822fb`, AUSD/USD `0xE20751C7B5867bCBef815ffc1b284c3f412a9e13`, ETH/USD `0x1B1414782B859871781bA3E4B0979b9ca57A0A04`; all 8 dp, live. MON/USD updated ~7 min apart in our sample (deviation/heartbeat-driven) | monad-crypto/protocols + `latestRoundData` | ✅ ⇒ **secondary guard only** (staleness for guard: 1 h, VERIFY exact heartbeat at data.chain.link if tighter needed) |
| R12 | Pyth | contract `0x2880aB155794e7179c9eE2e38200202908C17B43`; **MON/USD id `0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1`**, expo −8; sponsored push refreshes every ~10–30 s | Hermes API + `getPriceUnsafe` sampled 6× | ✅ ⇒ primary; our keeper/MM pushes Hermes updates to get ≤ 3 s freshness (maxStaleness 10 s assumes this) |
| R13 | Other oracles | Chronicle, Redstone, Stork, Supra | Monad docs | ✅ unused |
| R14 | Chainlink CRE on Monad | listed (mainnet + testnet). KeystoneForwarder mainnet `0x76c9cf548b4179F8901cda1f8623568b58215E62` (sim `0x9eF6468C5f37b976E57d52054c693269479A784d`); testnet `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` (sim `0xB9F79d863261869B234c481D1f9A7af84AeAd192`); chain names `monad-mainnet` / `monad-testnet` | CRE docs (Forwarder Directory); mainnet forwarders have code | ✅. Remaining: deploy access for our org (run `cre account` / request) |
| R15 | CRE consumer ABI | `onReport(bytes,bytes)` + ERC-165 | CRE docs | ✅ |
| R16 | Kuru mainnet contracts | Router `0xd651346d7c789536ebf06dc72aE3C8502cd695CC` (owner `0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b`); MarginAccount `0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5`; KuruFlowEntrypoint `0xb3e6778480b2E488385E8205eA05E20060B813cb`; KuruFlowRouter `0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2` | Kuru docs + onchain | ✅ |
| R17 | Kuru OrderBook ABI | **Docs are wrong.** Real: `placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minOut, bool isMargin, bool isFOK) payable returns (uint256)`, same for Sell; `bestBidAsk() returns (uint256,uint256)` 1e18-scaled. quoteSize in pricePrecision units; sell size in sizePrecision units with `msg.value` for native base | kuru-sdk ABI + **mainnet fork test: 10 USDC → 343.70 MON → sold half → 4.99 USDC** | ✅ CR-001 applied to `external/IKuruOrderBook.sol` |
| R18 | Kuru market creation | **NOT permissionless**: `deployProxy` from a random EOA reverts `Unauthorized()` | eth_call simulation | ❌ ⇒ any Kuru listing needs the Kuru team; the hackathon plan no longer depends on it (CR-003) |
| R19 | Kuru MON/AUSD spot | market `0x131a2e70a5b31a517a74b8c567149bc294470da9` exists (native MON base, AUSD quote, pricePrecision 1e8, sizePrecision 1e10, tick 100 = 0.000001) but is **dead**: one stale level ~30% off market, ~$5 depth, 0 trades/24h, AMM vault empty | onchain + exchange.kuru.io API | ❌ ⇒ vault cannot hedge on Kuru MON/AUSD directly (see §0.1) |
| R19b | Kuru liquid markets | MON/USDC `0x065c9d28e428a0db40191a54d33d5b7c71a9c394`: ~$16k bid / ~$16k ask within 1%, ~70k trades & ~482M MON (~$14M) per 24h. WETH/USDC `0xa6afd386135b7d41a6c40c525abc4a1019b0d132`: ~$34k/side within 1%, ~12.6k trades/24h. AUSD/USDC `0x699abc15308156e9a3ab89ec7387e9cfe1c86a3b`: ~$1.3k bid / $0.3k ask, 0 trades. WBTC/AUSD: empty. Uniswap V3/V4 MON/USDC pools (indexed by Kuru): $16–25k within 1% each | exchange.kuru.io/api/v3 depth + ticker | ✅ |
| R19c | Kuru Flow (aggregator) AUSD → MON | 1k AUSD: 0.01% vs mid; 10k: 0.34%; 50k: 7.5%. Executes via KuruFlowEntrypoint with **offchain-generated calldata** (`POST ws.kuru.io/api/quote`, JWT from `/api/generate-token`, 1 rps) | live quotes | ✅ ⇒ viable route for the spot leg up to ~$10–20k |
| R20 | Envio | HyperIndex supports 143 and 10143 **with HyperSync** (`https://143.hypersync.xyz`); requires an Envio API token | Envio supported-networks + live `/height` | ✅ get token at app.envio.dev |
| R21 | Privy | supports Monad (chain 143) as an EVM network; configure via `supportedChains` (viem chain) | Privy docs + Monad embedded-wallet guide | ✅ |
| R22 | Hackathon bounties (monad.xyz/metropolis) | Kuru $5k + $5k; **Agora $10k mobile trading**; **Privy $5k**; **Chainlink CRE $3k**; **Envio $1k** (+ $5k hosting for winners); **Aurora Intents $5k**; Dynamic $5k; Nansen $5k; Perpl $5k/$3k. Detailed criteria are behind the platform login | monad.xyz/metropolis | ⚠️ criteria: Samya must read them logged in. Signal: other Agora-mobile entrants use **Mera** (Category Labs passkey library) + native iOS; Agora's cross-border bounty reportedly requires Mera ⇒ check whether the mobile bounty does too |

| R23 | MON funding calibration (Hyperliquid, public `info` API) | last ~21 days (500 hourly samples): mean **13.8% APR**, median 10.95% (= HL interest floor), positive 97% of hours; max hourly +0.018%, min −0.011%. HL MON: max leverage **5x**, ~$18M 24h volume | api.hyperliquid.xyz `fundingHistory`, `metaAndAssetCtxs` | ✅ ⇒ interest i = 10.95% APR, 5x max (MATH_SPEC §1.3, §3.3) |
| R24 | Pyth Hermes (offchain price updates) | **API key required since 26 Aug 2026** (401 without). New endpoint `https://pyth.dourolabs.app/hermes`; routes and payloads unchanged; onchain interface unchanged | Pyth docs + CryptoSlate | ✅ ⇒ get a key (Founder B). Without a key, fall back to sponsored push (10–30 s) with maxStaleness 60 s |
| R25 | CRE deploy | deploy access is **gated** ("Requesting Deploy Access"); triggers: cron, HTTP, EVM log; EVM read/write | docs.chain.link/cre/capabilities | ⚠️ request access Day 1 (Founder B) |
| R26 | Mera | `@category-labs/mera` (npm), passkey → EVM key via WebAuthn PRF, works in web + native. The hackathon also lists **Mera bounties** ("Best Mera-Powered UX on Monad", "One Passkey, Many Keys") | github.com/category-labs/mera; bounty list quoted in a public entrant repo issue | ⚠️ amounts/criteria behind login |
| R27 | Monad perp competitors | Perpl (fully onchain CLOB, AUSD, <100k gas MM path, funding every 8,571 blocks ≈ 43 min, 9 markets, taker 8.8 bps / maker 5 bps, OI ≈ $1.8M, 24h vol ≈ $13.4M); Monday Trade (CLOB+AMM, 33x); LeverUp; Zaros. **None offers per-block funding, a funding oracle, a basis vault or fixed-rate funding.** Pendle Boros (Arbitrum) trades CEX funding via oracle, 1.2x cap at launch | orbitperpscreener, bingx, Boros docs | ✅ positioning (PRD §7) |
| R28 | Prior art on continuous funding & funding swaps | GMX v2: funding accrues **per second** (skew-based, pool model). Synthetix Perps v2: continuous "dynamic funding" (dr/dt ∝ skew). Rho Protocol (Arbitrum, Nov 2023): fixed-for-floating swaps on CEX/DEX perp funding via external index. Pendle Boros (2025): funding "Yield Units" via oracle. | Synthetix blog, GMX docs/README, Rho blog, Boros docs | ✅ ⇒ claims scoped in PRD §7.1 |
| R29 | Monad testnet (10143) network facts | Public RPCs `https://testnet-rpc.monad.xyz` (QuickNode, 50 rps; 25 rps for eth_call/estimateGas; archive), `https://rpc.ankr.com/monad_testnet`, `https://rpc-testnet.monadinfra.com` (20 rps); explorers testnet.monadvision.com / testnet.monadscan.com; faucet faucet.monad.xyz; WMON `0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541` (= decision 10); testnet re-genesis 2025-12-16 | docs.monad.xyz/developer-essentials/testnet (fetched 30 Sep 2026) + `cast chain-id` = 10143, WMON has code | ✅ keys/deploys still come from `.env` (`MONAD_TESTNET_RPC_URL`); the public RPC is used for read-only dry-runs and reads. Testnet Pyth MON/USD read 30 Sep: publishTime ~5.4 h old ⇒ keeper-fed oracle until a Hermes key exists |

### 0.1 Consequences of the second pass (decisions pending, see CHANGE_REQUESTS)
| Finding | Consequence | Recommended action |
|---|---|---|
| Kuru MON/AUSD dead, AUSD/USDC thin | The vault's spot leg can't be a simple `placeAndExecuteMarketBuy` on MON/AUSD | **CR-002 (proposed):** KuruHedger executes a keeper-supplied **Kuru Flow** route (calldata to KuruFlowEntrypoint), enforcing output by balance delta ≥ index-based minOut. Plus: our MM bot revives **Kuru MON/AUSD** by quoting it (hedged on MON/USDC), which is also a strong "new markets/liquidity on Kuru" story. Vault deposit cap ↓ to 10k AUSD at launch |
| `deployProxy` is owner-only | A PT/AUSD listing would depend on Kuru | **Resolved by CR-003:** fixed rate = funding swaps on Pulse's own order book. PT/YT is deferred |
| MON ≈ $0.029 | Tick/lot sizing | Pulse MON-PERP: tickSize 1e-6 AUSD (≈3.4 bps, same as Kuru), lotSize 100 MON (≈$2.9) |
| Pyth push cadence 10–30 s | Premium sampling freshness | Keeper pushes Hermes updates when older than 3 s or moved > 5 bps (WS-03) |
| MIP-8: first write to a page costs 2,800, and 17k per new slot | OB gas | Recycle order slots (free-list) instead of zeroing; the header and level slots in one page |
| Market choice | MON has deepest Kuru activity (70k trades/day); WETH has deeper 1% book but ~6× fewer trades | **Keep MON-PERP** |

## 1. Module diagram

```mermaid
flowchart LR
  subgraph Perp["MON-PERP (isolated state)"]
    OB[OrderBook<br/>generic CLOB] -- IMarginEngine hooks --> CH[ClearingHouse<br/>margin · funding F,G · liq<br/>+ IFundingRateOracle]
    CH -- views: mid, lastTrade --> OB
  end
  subgraph Swap["MON funding swap 30d (isolated state)"]
    OB2[OrderBook<br/>price = 1 + APR] -- IMarginEngine hooks --> FS[FundingSwapMarket]
  end
  FS -- reads F, G (O(1)) --> CH
  CH -- getIndexPrice --> OA[OracleAdapter<br/>Pyth primary · Chainlink guard]
  CH & FS -- coverBadDebt / surplus --> IF[InsuranceFund]
  V[PulseVault ERC-4626<br/>skew absorber] -- short, deposit --> CH & OB
  V -. stretch: lock fixed .-> OB2
  V -- buy/sell spot --> KH[KuruHedger] --> KF[(Kuru Flow / Kuru CLOB)]
  subgraph Offchain
    TSK[TS keeper] --> V & CH & FS & OA
    CRE[Chainlink CRE<br/>(should)] --> KR[KeeperReceiver] --> V & CH
    MM[MM bot A–S] --> OB & OB2
    ENV[Envio HyperIndex] --> APP[Next.js PWA]
  end
```

| Module | Path | Owner | Deployed |
|---|---|---|---|
| OrderBook | `contracts/src/orderbook/OrderBook.sol` | WS-01 | 1 per market |
| ClearingHouse (+ IFundingRateOracle) | `contracts/src/clearing/ClearingHouse.sol` | WS-02 | 1 per market |
| FundingLib, MarkPriceLib, MarginLib | `contracts/src/libs/` | WS-02 | internal libs |
| InsuranceFund | `contracts/src/clearing/InsuranceFund.sol` | WS-02 | 1 global |
| MarketFactory (registry) | `contracts/src/clearing/MarketFactory.sol` | WS-02 | 1 global |
| OracleAdapter | `contracts/src/oracle/PythChainlinkOracleAdapter.sol` | WS-03 | 1 per market |
| KeeperReceiver | `contracts/src/automation/PulseKeeperReceiver.sol` | WS-03 | 1 global |
| PulseVault + KuruHedger | `contracts/src/vault/` | WS-04 | 1 each |
| FundingSwapMarket (+ its OrderBook instance) | `contracts/src/swaps/` | WS-05 | 1 per maturity |

## 2. Call flows

### 2.1 Place limit order (maker, rests)
1. `OB.placeLimitOrder(isBid, tick, lots, flags)`. Validate tick/lots, `openOrderCount < 64`, POST_ONLY cross check.
2. Match any crossing part (see 2.2).
3. Remainder: `CH.reserveOrderMargin(maker, side, size, price)`. CH calls `_touchFunding()` then checks `equity ≥ IM + reserved + new`; otherwise it reverts.
4. Append to level FIFO, set bitmap bit, emit `OrderPlaced`.

### 2.2 Match (taker)
```
loop fills ≤ MAX_FILLS_PER_ORDER (32):
  best = bitmap.next(side)            // O(1) word scan, O(log) worst over 2-level bitmap
  if best worse than limit: break
  maker order = level.head
  ok = CH.settleMakerFill(maker, …)   // funding touch (first call in the block writes F), position update, fee
  if !ok: evict order, emit OrderEvicted, continue
  update order/level/bitmap; emit Trade
CH.settleTakerFill(taker, side, Σsize, Σnotional, reduceOnly)   // single IM check, reverts whole tx
```
Taker IM is checked once at the end. That is safe because the whole tx reverts on failure.

### 2.3 Funding touch (first tx per block per market)
`CH._touchFunding()`: `if (fs.lastUpdateBlock == block.number) return;` else read index (oracle), book mid, last trade → `FundingLib.update(fs, params, …)` → write the single packed FundingState → emit `FundingUpdated`. All later txs in the same block only read it. Every CH entrypoint calls it (deposit, withdraw, settle*, reserve*, liquidate, updateFunding).

### 2.4 Liquidation
Keeper (CRE log/cron trigger or TS fallback) computes liquidatable accounts offchain from indexer positions and mark. Then `CH.liquidate(account, maxSize)`: touch funding → settle account funding → require `equity < MM` → transfer `min(maxSize,|size|)` to the liquidator at mark (liquidator must pass IM after) → penalty split (keeper / InsuranceFund) → if collateral < 0: `IF.coverBadDebt` and record any uncovered part as `totalBadDebt` (ADL = roadmap). Resting orders of the liquidatee stay; they are evicted lazily on fill (`settleMakerFill` returns false).

### 2.5 Vault deposit / rebalance / exit
- `deposit(assets)`: pure ERC-4626 mint at NAV. Assets stay idle (no trading in user tx).
- `rebalance()` (keeper): compute `needsRebalance()` →
  - **Deploy**: idle − buffer = D' → N = D'·L/(L+1) → `hedger.buySpot(N)` → `CH.deposit(N/L)` → `OB.placeMarketOrder(ask, N/price)` (short).
  - **DeltaDrift**: trim the larger leg toward netDelta = 0.
  - **MarginLow**: sell spot slice → deposit AUSD to CH (or reduce both legs).
  - **ExitHedge**: close the short (market buy, reduceOnly), sell all spot, withdraw CH collateral → idle.
- `withdraw/redeem`: served from idle. If short, unwind a pro-rata slice of both legs inline (bounded: one spot sell plus one perp market order), with a withdrawal fee of 5 bps (tunable) credited to remaining holders.

### 2.6 Funding swap: trade, accrue, mature
- Trade: `OB2.placeLimitOrder/placeMarketOrder` with price = 1 + APR → `FS.reserveOrderMargin` / `settleMakerFill` / `settleTakerFill` (same IMarginEngine protocol as the perp).
- Accrue: every FS entrypoint calls `CH.latestObservation()` (one external view, O(1)) and settles the touched accounts: `net = q·ΔF − K·ΔG/YEAR` (MATH_SPEC §6.2).
- Mature: anyone calls `settleMaturity()` once `block.timestamp ≥ maturity`; F and G are snapshotted and accrual stops. Positions can then only be closed; collateral is withdrawable.
- Liquidation: same shape as the perp (liquidator takes over at markApr).

### 2.7 Funding rate oracle
Inside `CH._touchFunding()`: after updating F and G, if a new 200-block bucket started, write a checkpoint into the 1440-slot ring buffer and emit `FundingCheckpoint`. Views compute ΔF/ΔG. No extra transactions and no loops.

## 3. Storage layout plan (MIP-8 aware)

| Contract | Slot group (target same 4 KB page) | Rationale |
|---|---|---|
| ClearingHouse | slots 0..~20: internal packed funding state (slot A: `int256 F`; slot B: `int80 emaPremium, int80 rate, uint64 lastUpdateBlock`; the interface's `FundingState` is only the view shape), RiskParams, FundingParams, OI, fees. `oracle`/`IF`/`AUSD` are immutables (no SLOAD); `orderBook` is set once (same page as the header) | One page warm for the whole hot path: first touch 8,100 gas, then 100 per read |
| OrderBook | header (bestBid, bestAsk, lastTrade, nextOrderId) packed into 2 slots at the start; bitmap words `mapping(uint256 => uint256)` | Header + params share a page |
| OrderBook levels | **Level array layout**: store levels in a fixed-base array `levels[tick]` (`uint256` packed: head orderId, tail orderId, totalLots). Adjacent ticks → adjacent slots → the same 4 KB page covers 128 consecutive ticks | MM quoting ±N ticks around mid touches 1 page. This is the MIP-8 win to benchmark |
| OrderBook orders | `orders[orderId]` = 1 slot: `maker(160) | lots(64) | next(32)` plus tick stored in level | 1 SSTORE per placement; sequential orderIds → adjacent slots → the MM's successive orders share pages |
| CH accounts | `mapping(address => Account)`, 3–4 slots contiguous per account | Per-account isolation (hash-scattered ⇒ no cross-user page sharing, which is good for parallelism) |

MIP-8 SSTORE pricing is verified (R5): the first write to a page costs 2,800, later writes to the same page cost 0, and each zero→nonzero slot costs 17,000 with no refunds. The benchmark (BENCHMARKS_PLAN B3) measures array vs mapping for levels.

## 4. Parallel-execution conflict analysis (Monad optimistic parallel execution)

Monad executes txs optimistically in parallel and re-executes those whose read set was invalidated by an earlier tx in the block. Minimizing shared write slots keeps re-execution rare.

| Tx A \ Tx B | Same market trade | Other market trade | Deposit (same market) | Vault deposit |
|---|---|---|---|---|
| Trade market X | **Conflict**: book levels, bestBid/Ask, lastTrade, OI, FundingState (only first tx writes F) | **None**: disjoint contracts | Minor: AUSD `balanceOf[CH_X]` if deposit and trade both move tokens; trades don't move tokens ⇒ none | None |
| Deposit market X | — | None | Conflict on AUSD `balanceOf[CH_X]` (ERC-20 inherent) | None |
| Vault deposit | None | None | None | Conflict on `totalSupply` and AUSD `balanceOf[vault]` (ERC-4626 inherent) |

Design rules applied:
1. **One CH + OB per market**, so markets never share state (the multi-market load test in B4 demonstrates this).
2. **Funding written once per block per market.** The first touch writes; later txs read. Read-after-write within the block is resolved by Monad's re-execution with cached state.
3. **Fees accrue in a per-market counter** inside the already-conflicting market state, never in a global treasury slot. `collectFees` is rare.
4. **InsuranceFund is off the hot path** (liquidations only).
5. **MarketFactory is never read on the hot path** (addresses are immutables in CH/OB).
6. Trades don't move tokens (collateral is internal accounting), so they don't write AUSD balances.

## 5. Trust assumptions
| Actor | Power | Mitigation |
|---|---|---|
| Owner (Samya multisig/EOA for hackathon) | set params within hard-coded bounds, pause, register markets, collect fees | params bounded in setters (e.g. `mmr ≤ imr`, `rateCap ≤ 1%/h`); timelock = roadmap |
| Oracle (Pyth + Chainlink) | index price | staleness and deviation guard; stale ⇒ reduce-only, funding accrual frozen |
| Keepers (CRE / TS) | trigger rebalance/liquidation | permissionless liquidation; vault keeper-gated but can only execute the rule-based `rebalance()` with slippage caps |
| Kuru | spot execution for the vault | slippage caps, NAV at oracle index, not Kuru mid |
| Agora | AUSD issuer | depeg monitored via Chainlink AUSD/USD; pause deposits if < 0.99 |

## 6. Upgradeability
**Non-upgradeable for the MVP** (decision). Rationale: smaller audit surface, no proxy storage-collision risk for 9 parallel engineers, judges read plain contracts. Migration path = deploy v2 markets and close v1 (reduce-only). Params are mutable within bounds; code is not.

## 7. Deployment order (script owned by WS-00 skeleton, filled by WS-08)
1. InsuranceFund(AUSD) → 2. OracleAdapter(MON/USD) → 3. ClearingHouse(AUSD, oracle, IF, params) → 4. OrderBook(CH, tickSize, lotSize) → 5. `CH.setOrderBook(OB)` → 6. `IF.setMarketAuthorized(CH)` → 7. `MarketFactory.registerMarket` → 8. KuruHedger(Kuru Flow entrypoint; see CR-002) → 9. PulseVault(AUSD, CH, OB, hedger) → 10. FundingSwapMarket(CH, AUSD, IF, maturity, params) → 11. OrderBook(FS, tick 1e14 = 1 bp APR, lot 1,000 MON) → 12. `FS.setOrderBook` + `IF.setMarketAuthorized(FS)` → 13. KeeperReceiver(forwarder) (if CRE).
