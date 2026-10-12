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

/**
 * Top bar, Hyperliquid layout: logo and wordmark, plain text links (the current page in the light accent), and on the
 * right the network chip, block counter, outlined icon buttons and the filled Connect button.
 * Phones: logo + controls; page navigation stays on the bottom tabs.
 */
export function NavBar() {
  const path = usePathname() ?? "";
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-card pt-[env(safe-area-inset-top)]">
        <div className="flex h-14 w-full items-center justify-between gap-3 px-3 lg:px-5">
          <div className="flex min-w-0 items-center gap-8">
            <Link href="/" className="flex shrink-0 items-center gap-2 rounded-control pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center" aria-label="Meridian home">
              <Image src="/meridian-logo.png" alt="" width={26} height={26} priority />
              {/* below 420 px the logo carries the brand so the network chip and controls fit */}
              <span className="text-[19px] font-medium tracking-tight max-[419px]:sr-only">Meridian</span>
            </Link>
            <nav aria-label="Main" className="hidden lg:block">
              <ul className="flex items-center gap-7">
                {NAV_ITEMS.map((t) => {
                  const active = isActive(path, t.href);
                  return (
                    <li key={t.href}>
                      <Link
                        href={t.href}
                        aria-current={active ? "page" : undefined}
                        className={`inline-flex h-14 items-center text-[15px] transition-colors ${active ? "text-brand-soft" : "text-text hover:text-brand-soft"}`}
                      >
                        {t.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden md:inline-flex">
              <NetworkChip />
            </span>
            <span className="hidden sm:inline-flex">
              <BlockCounter />
            </span>
            <AccountMenu />
            <Bell />
            <SettingsMenu />
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
