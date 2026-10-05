"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Notice } from "@/components/ds";
import { AccountMenu } from "./AccountMenu";
import { Bell } from "./Bell";
import { BlockCounter } from "./BlockCounter";
import { NetworkChip, isNotDeployed, networkName } from "./NetworkChip";
import { NAV_ITEMS, isActive } from "./items";
import { SettingsMenu } from "./SettingsMenu";
import { StatusChip } from "./StatusChip";

/**
 * Floating rounded navbar (FRONTEND_TRADE_PLAN §5). Desktop (≥ 1024 px): logo · page pills · block, bell, account.
 * Phones: compact bar; page navigation stays on the existing bottom tabs.
 */
export function NavBar() {
  const path = usePathname() ?? "";
  return (
    <>
      {/* full-width bar: flush with the top and both edges, square corners, a hairline below */}
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="flex h-14 w-full items-center justify-between gap-2 px-3 lg:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Link href="/trade" className="flex shrink-0 items-center gap-2 rounded-full pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center" aria-label="Meridian home">
              <Image src="/meridian-logo.png" alt="" width={24} height={24} priority />
              {/* below 420 px the logo carries the brand so the network chip and controls fit */}
              <span className="text-base font-semibold tracking-tight max-[419px]:sr-only">Meridian</span>
            </Link>
            <NetworkChip />
          </div>
          <nav aria-label="Main" className="hidden lg:block">
            <ul className="flex items-center gap-1 rounded-full bg-card-2 p-1">
              {NAV_ITEMS.map((t) => {
                const active = isActive(path, t.href);
                return (
                  <li key={t.href}>
                    <Link
                      href={t.href}
                      aria-current={active ? "page" : undefined}
                      className={`inline-flex h-8 items-center rounded-full px-4 text-sm font-medium transition-colors ${active ? "bg-brand text-on-brand" : "text-muted hover:text-text"}`}
                    >
                      {t.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="flex shrink-0 items-center gap-1">
            <span className="hidden xl:inline-flex">
              <StatusChip />
            </span>
            <span className="hidden sm:inline-flex">
              <BlockCounter />
            </span>
            <SettingsMenu />
            <Bell />
            <AccountMenu />
          </div>
        </div>
      </header>
      {isNotDeployed() && (
        <div className="mx-auto mt-2 w-full max-w-[430px] px-4 lg:max-w-[1696px] lg:px-2">
          <Notice tone="warn">Meridian isn&apos;t live on {networkName()} yet. Everything below is sample data, and no transactions can be sent to it.</Notice>
        </div>
      )}
    </>
  );
}
