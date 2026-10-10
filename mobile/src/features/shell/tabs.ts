import type { TabIconName } from "../../ui";

/** Home · Trade · Earn · Settings (MOBILE_PLAN §1.1). Home is the portfolio route, first and the default after unlock. */
export const TABS: { name: TabIconName; title: string }[] = [
  { name: "portfolio", title: "Home" },
  { name: "trade", title: "Trade" },
  { name: "earn", title: "Earn" },
  { name: "settings", title: "Settings" },
];
