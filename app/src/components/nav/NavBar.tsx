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
      <header className="sticky top-0 z-30 px-2 pt-[calc(8px+env(safe-area-inset-top))]">
        <div className="mx-auto flex h-14 w-full max-w-[414px] items-center justify-between gap-2 rounded-full border border-border bg-card/90 pl-3 pr-2 backdrop-blur card-elev lg:max-w-[1680px]">
          <div className="flex min-w-0 items-center gap-2">
            <Link href="/trade" className="flex shrink-0 items-center gap-2 rounded-full" aria-label="Meridian home">
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
