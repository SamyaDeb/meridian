export const faqs = [
  { q: "1. What is per-block funding?", a: "Funding accrues every Monad block (about 300 ms) through a single index, so a position pays or receives funding continuously instead of in hourly or 8-hour lumps. There is no funding snapshot to time." },
  { q: "2. What can I trade?", a: "MON-PERP, a perpetual on MON with up to 5x leverage on a fully onchain order book. Collateral is AUSD." },
  { q: "3. How does the basis vault earn?", a: "The vault takes the other side of the market's skew and earns the funding that side receives, so its share price rises as funding accrues. While it has no route to deploy, it stays idle and the app says so." },
  { q: "4. What is a funding swap?", a: "It exchanges floating funding for a fixed APR until maturity. Go long to pay fixed and receive floating, which turns a perp long's funding into a known cost; go short to receive the fixed rate." },
  { q: "5. What happens if my margin runs low?", a: "When an account's equity falls below maintenance margin, anyone can liquidate it. An insurance fund covers bad debt." },
];

export const footLinks = [
  { l: "Trade", h: "/trade" },
  { l: "Earn", h: "/earn" },
  { l: "Fix", h: "/fix" },
  { l: "Rates", h: "/rates" },
  { l: "Stats", h: "/stats" },
];

export const footResources = [
  { l: "GitHub", h: "https://github.com/SamyaDeb/meridian" },
  { l: "Terms & risks", h: "/terms" },
];

export const prismFaces = [{ r: 0 }, { r: -90 }, { r: -180 }, { r: -270 }];

export const dashRows = [
  { c: "#aba0ea" },
  { c: "#aba0ea" },
  { c: "#aba0ea" },
  { c: "#836ef9" },
  { c: "#aba0ea" },
  { c: "#aba0ea" },
];

export const stats = [
  { label: "Funding interval", n: 300, unit: "ms", sup: "", desc: "Funding accrues every Monad block, not in hourly or 8-hour lumps." },
  { label: "Max leverage", n: 5, unit: "x", sup: "", desc: "MON-PERP on a fully onchain order book, margined in AUSD." },
  { label: "Swap maturity", n: 30, unit: "d", sup: "", desc: "Lock a fixed funding APR for 30 days with a funding swap." },
];

export const logos = [
  { t: "◆ Monad", ls: "-0.02em" },
  { t: "AUSD", ls: "0.04em" },
  { t: "Chainlink CRE", ls: "-0.02em" },
  { t: "Envio", ls: "-0.02em" },
  { t: "Privy", ls: "0.02em" },
];

export const tiles = [
  { label: "Per-block funding", d: "M9 10V20H5V10zM11 20h6.5a2 2 0 0 0 2-1.6l1.3-6A2 2 0 0 0 18.8 10H15V6a2.5 2.5 0 0 0-2.5-2.5L11 9z" },
  { label: "Onchain order book", d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v5.4l3.5 2.1-1 1.7L11 13.5V7z" },
  { label: "AUSD collateral", d: "M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5zm-1.2 13.2l5.6-5.6-1.4-1.4-4.2 4.2-2-2-1.4 1.4z" },
  { label: "Funding oracle", d: "M12 5a6 6 0 0 0-3.5 10.9V18h7v-2.1A6 6 0 0 0 12 5zM9.5 20h5v2h-5zM11 1h2v2.5h-2zM1 11h2.5v2H1zM20.5 11H23v2h-2.5zM4 3.5l1.8 1.8-1.4 1.4-1.8-1.8zM20 3.5l1.4 1.4-1.8 1.8-1.4-1.4z" },
  { label: "Basis vault", d: "M13.5 2l.5 2.6 2.3 1 2.2-1.5 2.1 2.1-1.5 2.2 1 2.3 2.6.5v3l-2.6.5-1 2.3 1.5 2.2-2.1 2.1-2.2-1.5-2.3 1-.5 2.6h-3l-.5-2.6-2.3-1-2.2 1.5-2.1-2.1 1.5-2.2-1-2.3L2 13.5v-3l2.6-.5 1-2.3-1.5-2.2 2.1-2.1 2.2 1.5 2.3-1 .5-2.6zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z" },
  { label: "Funding swaps", d: "M4 4h7L4 11zM13 4h7L4 20v-7zM20 9.5V20H9.5z" },
];
