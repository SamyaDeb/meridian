// Terms of use + risk disclosure: DRAFT written by the Phase 5 C session. NOT legal advice and NOT in force until
// all three founders sign off. Placeholders in [brackets] are for the founders.
// Bump TERMS_VERSION in src/lib/terms.ts on any material change so every viewer accepts again.

export const TERMS_STATUS: "draft" | "signed-off" = "draft";

export type TermsSection = { heading: string; body: string[] };

export const TERMS_SUMMARY = [
  "Meridian is experimental, non-custodial software on Monad. You keep your keys; transactions are final.",
  "Perpetuals use leverage: positions can be liquidated and you can lose all deposited collateral.",
  "Funding is paid or received every block and can move against you.",
  "Vault and swap returns are not guaranteed; the vault can lose value and withdrawals may wait for an unwind.",
  "You confirm you are not in a restricted jurisdiction and are allowed to use this software where you are.",
];

export const TERMS_SECTIONS: TermsSection[] = [
  {
    heading: "1. What Meridian is",
    body: [
      "Meridian is a set of smart contracts on the Monad blockchain (a perpetual futures market with per-block funding, a basis vault and funding-rate swaps) and this web interface to them. The interface only prepares transactions; your wallet signs them and the contracts execute them.",
      "Meridian is operated by [legal entity / founders' names, to be set by the founders]. It was built for the Monad Metropolis hackathon and is early-stage software. The contracts are not upgradeable and have not had an external audit (see the security review published with the project).",
    ],
  },
  {
    heading: "2. Eligibility and restricted jurisdictions",
    body: [
      "You may use Meridian only if you are legally able to enter into these terms and to use leveraged derivatives and on-chain financial software where you live and where you access it from.",
      "You may not use Meridian if you are located in, resident in, or a national of a restricted jurisdiction, or if you are subject to sanctions. The list of restricted jurisdictions is: [to be decided by the founders]. The interface may refuse access or write actions based on your location; do not try to get around it (for example with a VPN).",
    ],
  },
  {
    heading: "3. Non-custodial use",
    body: [
      "We never hold your funds or keys. Deposits sit in the smart contracts under the rules written in their code. If you lose access to your wallet, nobody can recover your funds for you.",
      "Blockchain transactions cannot be reversed. Check every transaction before you sign it.",
    ],
  },
  {
    heading: "4. Risks you accept",
    body: [
      "Leverage and liquidation: if your equity falls below the maintenance margin, anyone may liquidate your position; you pay a liquidation penalty and can lose all collateral in that market.",
      "Funding: long and short positions pay or receive funding every block, based on the market's own premium. The rate can change quickly.",
      "Oracle and market risk: prices come from an external oracle (Pyth) and from the on-chain order book. Oracle delays, outages or errors can affect marks, liquidations and trading. Markets can be thin; orders may not fill or may fill at worse prices.",
      "Vault risk: the basis vault holds spot MON and a short MON-PERP position. Its value can fall (for example from negative funding, trading costs or a spot-route failure). Withdrawals above the vault's idle cash need an unwind; they can cost more than the quoted fee, or wait until the operator's keeper completes an unwind. Past or displayed yields are not a promise of future returns.",
      "Funding-swap risk: fixed-for-floating swaps settle against the realized per-block funding until maturity; a position can lose money and can be liquidated.",
      "Smart-contract and chain risk: the code may contain bugs; Monad itself may halt, reorganize or change. Bad debt that the insurance fund can't cover stays with the liquidated account and is not socialized automatically.",
      "Caps and pauses: the operator can pause markets and change risk parameters within limits written in the contracts (admin is a multi-signature wallet).",
    ],
  },
  {
    heading: "5. No advice",
    body: [
      "Nothing in Meridian is investment, financial, legal or tax advice. Numbers shown in the app (APRs, liquidation prices, previews) are estimates computed from on-chain data and may differ from what executes.",
    ],
  },
  {
    heading: "6. Fees",
    body: ["Trading, liquidation and vault withdrawal fees are set in the contracts and shown before you sign. You also pay Monad network gas."],
  },
  {
    heading: "7. No warranty; limitation of liability",
    body: [
      "Meridian is provided \"as is\" and \"as available\", without warranties of any kind. To the maximum extent the law allows, the founders are not liable for losses from using Meridian, including losses from liquidations, funding, oracle failures, bugs or network issues. [Founders: confirm wording and governing law.]",
    ],
  },
  {
    heading: "8. Changes and contact",
    body: [
      "We may update these terms; the app will ask you to accept a new version before your next write action. Questions and support: [support channel, to be set by the founders].",
    ],
  },
];
