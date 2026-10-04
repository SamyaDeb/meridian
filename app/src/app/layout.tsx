import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { BottomTabs } from "@/components/BottomTabs";
import { TopBar } from "@/components/TopBar";
import { ServiceWorker } from "@/components/ServiceWorker";
import Link from "next/link";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Pulse: per-block funding on Monad",
  description: "Trade MON-PERP with funding every block, earn the basis, or fix your funding rate. All in AUSD.",
  applicationName: "Pulse",
  appleWebApp: { capable: true, title: "Pulse", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0a0b10",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-bg font-sans text-text">
        <Providers>
          {/* 390×844 first; centered column on larger screens */}
          <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col">
            <TopBar />
            <main className="flex-1 px-4 pb-[calc(76px+env(safe-area-inset-bottom))] pt-2">
              {children}
              <footer className="mt-6 flex justify-center gap-4 text-[11px] text-muted">
                <Link href="/terms" className="inline-flex min-h-11 items-center underline">
                  Terms &amp; risks
                </Link>
              </footer>
            </main>
            <BottomTabs />
          </div>
        </Providers>
        <ServiceWorker />
      </body>
    </html>
  );
}
