"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export const TABS = [
  { href: "/trade", label: "Trade", icon: "M3 17l5-5 4 4 8-8M15 8h5v5" },
  { href: "/positions", label: "Positions", icon: "M4 6h16M4 12h16M4 18h10" },
  { href: "/earn", label: "Earn", icon: "M12 3v18M7 8h7a3 3 0 010 6H9a3 3 0 000 6h8" },
  { href: "/fix", label: "Fix", icon: "M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4l3 2" },
  { href: "/stats", label: "Stats", icon: "M5 20V10M12 20V4M19 20v-7" },
] as const;

export function BottomTabs() {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 lg:hidden mx-auto w-full max-w-[430px] border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="grid grid-cols-5">
        {TABS.map((t) => {
          const active = path === t.href || path.startsWith(`${t.href}/`);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-[60px] flex-col items-center justify-center gap-1 text-[11px] ${active ? "text-accent" : "text-muted"}`}
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={t.icon} />
                </svg>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
