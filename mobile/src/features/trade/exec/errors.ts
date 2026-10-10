// Trade failures in plain words that say what happened and what to do (research M7: name the exact problem, keep the
// input). Meridian reverts arrive as wallet/revert's "The contract refused: <humanized error>." (error names from
// abis/OrderBook.json + ClearingHouse); Perpl's come from core explainOrder / the leg and are already plain.
const MERIDIAN: [RegExp, string][] = [
  [/slippage exceeded/i, "The price moved past your worst price, so nothing filled. Try again, or allow more slippage."],
  [/insufficient margin/i, "Not enough collateral on Meridian for this size. Lower the amount or the leverage."],
  [/no liquidity/i, "Meridian's book has no liquidity on that side right now. Nothing filled."],
  [/reduce only violated/i, "There's no position on Meridian to close."],
  [/paused/i, "Meridian trading is paused right now. Nothing was sent."],
  [/oracle stale/i, "Meridian's price feed is updating. Try again in a few seconds."],
  [/position cap exceeded|open interest cap exceeded/i, "This size is above Meridian's limit. Try a smaller amount."],
  [/invalid size/i, "That size isn't a whole number of Meridian lots."],
  [/insufficient funds|gas/i, "Not enough MON for the network fee. Add a little MON and try again."],
];

/** A trade error → the sentence the sheet / receipt shows. Unknown text passes through (it is already plain). */
export function plainTradeError(raw: string | undefined): string {
  if (!raw) return "The order didn't go through. Nothing filled.";
  const msg = raw.replace(/^prepare: /, "");
  for (const [re, text] of MERIDIAN) if (re.test(msg)) return text;
  if (/user cancel|cancelled|canceled|NotAllowedError/i.test(msg)) return "Cancelled. Nothing was sent.";
  if (/network request failed|fetch failed|timeout/i.test(msg)) return "Couldn't reach the network. Nothing was sent; check your connection and try again.";
  return msg;
}
