import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter_Tight } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { BottomTabs } from "@/components/BottomTabs";
import { NavBar } from "@/components/nav/NavBar";
import { ServiceWorker } from "@/components/ServiceWorker";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { Toaster } from "@/components/Toaster";
import { CommandPalette } from "@/components/CommandPalette";
import { AppBackground } from "@/components/AppBackground";
import { StatusBar } from "@/components/StatusBar";

// Inter Tight = landing-page parity (UI); Geist Mono = tabular numbers.
const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin", "latin-ext"], weight: ["400", "500", "600", "700"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Absolute og:image URLs need the public origin; set NEXT_PUBLIC_SITE_URL on the hosted build (unset ⇒ Next's default).
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

export const metadata: Metadata = {
  ...(SITE_URL ? { metadataBase: new URL(SITE_URL) } : {}),
  title: "Meridian: per-block funding on Monad",
  description: "Trade MON-PERP with funding every block, earn the basis, or fix your funding rate. All in AUSD.",
  applicationName: "Meridian",
  appleWebApp: { capable: true, title: "Meridian", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0d0919", // = --card in globals.css (the navbar colour; metadata needs a literal)
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${interTight.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full font-sans text-text">
        <Providers>
          {/* 390×844 first; phone column centred on larger screens, desktop container on wide routes (Shell) */}
          <div className="flex min-h-dvh w-full flex-col">
            <AppBackground />
            <NavBar />
            <main className="flex-1 px-4 pb-[calc(76px+env(safe-area-inset-bottom))] pt-2 lg:px-1 lg:pb-9 lg:pt-1">
              <Shell
                footer={
                  <footer className="mt-6 flex justify-center gap-4 text-[11px] text-muted lg:hidden">
                    <Link href="/terms" className="inline-flex min-h-11 items-center underline">
                      Terms &amp; risks
                    </Link>
                  </footer>
                }
              >
                {children}
              </Shell>
            </main>
            <BottomTabs />
            <StatusBar />
            <Toaster />
            <CommandPalette />
          </div>
        </Providers>
        <ServiceWorker />
      </body>
    </html>
  );
}
