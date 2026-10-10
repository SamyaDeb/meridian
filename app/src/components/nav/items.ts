/** Global navigation (FRONTEND_TRADE_PLAN §5). Order is the product story: trade → hold → earn → fix → the rate itself. */
export const NAV_ITEMS = [
  { href: "/trade", label: "Trade" },
  { href: "/positions", label: "Positions" },
  { href: "/earn", label: "Earn" },
  { href: "/fix", label: "Fix" },
  { href: "/rates", label: "Rates & Risk" },
  { href: "/stats", label: "Stats" },
] as const;

export const isActive = (path: string, href: string): boolean => path === href || path.startsWith(`${href}/`);
