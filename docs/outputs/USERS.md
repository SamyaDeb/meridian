# USERS: external user pipeline (Phase 5 → Phase 6)

> **7 Oct 2026 (PHASES 40, no mainnet before the hackathon):** the mainnet targets below can't be met and are not claimed. Users are now **testnet testers** on 10143 ([`TESTNET_GUIDE.md`](TESTNET_GUIDE.md)); record them in the "Testnet testers" table, labelled testnet, same consent rules. As of 7 Oct: **0 external testers**. **8 Oct (K6):** counts now come from `indexer/scripts/users-report.mjs` (needs the hosted indexer for the current deployment), which excludes deployments' operators and every wallet in [`test-wallets.json`](test-wallets.json); addresses are listed only from [`users-consent.json`](users-consent.json). Testnet activity so far is only our own keys (deployer, keepers, MMs, flow) and two labelled test wallets (`0x6d2d…58b7`, `0x6058…35f4`), none of which count.

Targets (original, mainnet): **≥ 5 external users on mainnet by Sat 10 Oct (G5)** and ≥ 50 by Tue 13 Oct (PRD §6).

Rules (non-negotiable):
- Record **only what really happened**. Never fabricate, estimate or round up users. Test wallets, founders' wallets and the MM/keeper/deployer keys are **not** external users.
- Put a wallet address or tx hash here **only with the person's consent** (ask: "OK to list your address in our hackathon proof?"). Without consent, write `consented: no` and leave the address out; the count still comes from onchain data, verified by a founder.
- A user is **onboarded** after their first mainnet tx on Meridian (deposit, trade, vault deposit or swap) and **active** after a second action on a later day.
- "Source" = where they came from (e.g. Monad Discord #metropolis, a bounty channel, a friend, X). "Contact" = a handle or channel, never private contact details.

## Summary
| Date | Contacted | Onboarded (≥ 1 mainnet tx) | Active | Verified by |
|---|---|---|---|---|
| 2026-09-30 | 0 | 0 | 0 | — (mainnet not deployed) |

## Pipeline
| # | Contact (handle / channel) | Source | Status (contacted / onboarded / active) | First action | First tx hash (only with consent) | Consented to listing | Notes |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | (no rows yet) |

## Outreach plan (Thu 8 – Sat 10 Oct)
| When | Channel | Message (≤ 3 lines, only PRD §7.1 ✅ claims) | Owner |
|---|---|---|---|
| Thu 8 Oct | Monad Discord (hackathon / community channels; follow each channel's self-promo rules) | "We built Meridian: per-block funding on a fully onchain order book on Monad. Trade MON-PERP, earn the basis in a vault, or fix your funding rate. Looking for testers on mainnet day (Sat 10 Oct): small sizes, AUSD." + onboarding link | C |
| Thu 8 Oct | Bounty channels (Agora, Envio, Kuru, login provider) | Short intro + the demo link; ask for feedback, not for users | C |
| Fri 9 Oct | Friends who trade perps (DMs, only people who opted in) | Onboarding guide + "reply when you have AUSD + MON on Monad" | A, B, C (each lists their own contacts here) |
| Sat 10 Oct (after deploy + A's go) | Same channels | "Live on Monad mainnet" + contract addresses from `deployments/143.json` + onboarding guide | C |
| Sun 11 – Tue 13 Oct | Follow-ups; support thread | Answer questions; record every onboarded user here the same day | C |

Never promise returns, airdrops or points. Link the risk disclosure (`/terms`) in every post.

## Testnet testers (10143, from 7 Oct)
| # | Contact (handle / channel) | Source | First action | First tx hash (only with consent) | Consented to listing | Verified by |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | (no rows yet) |
