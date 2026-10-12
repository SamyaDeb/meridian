"use client";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * Routes that use the desktop container at ≥ 1024 px (FRONTEND_TRADE_PLAN F0.4). Every other route keeps the
 * phone column (430 px minus the 16 px gutters = 398 px), centred, until its page is restyled (F2 Trade, F5 the rest). Phones are unaffected either way.
 */
export const WIDE_ROUTES = ["/design", "/trade", "/earn", "/fix", "/stats", "/positions", "/rates"] as const;
/** Full-viewport routes at ≥ 1280 px: the layout footer is hidden there and the page carries its own Terms link. */
export const TERMINAL_ROUTES = ["/trade"] as const;
export const isTerminalRoute = (path: string): boolean => TERMINAL_ROUTES.some((r) => path === r);

export const isWideRoute = (path: string): boolean => WIDE_ROUTES.some((r) => path === r || path.startsWith(`${r}/`));

export function Shell({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const path = usePathname() ?? "";
  const wide = isWideRoute(path);
  return (
    <>
      {/* terminal: edge to edge (Hyperliquid); other wide pages: a centred 1600 px column with generous margins */}
      <div className={`mx-auto w-full ${isTerminalRoute(path) ? "max-w-[398px] lg:max-w-none" : wide ? "max-w-[398px] lg:max-w-[1600px] lg:px-10 lg:pt-8" : "max-w-[398px]"}`}>{children}</div>
      <div className={isTerminalRoute(path) ? "xl:hidden" : undefined}>{footer}</div>
    </>
  );
}
