import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Inter_Tight } from "next/font/google";
import "./landing.css";

// Own root layout: the landing page renders without the app's navbar, tabs and wallet providers.
const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin", "latin-ext"], weight: ["400", "500", "600", "700"], display: "swap" });

export const metadata: Metadata = {
  title: "Meridian",
  description: "Trade MON-PERP with funding every block, earn the basis, or fix your funding rate. All in AUSD.",
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

export default function LandingLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={interTight.variable}>
      <body>{children}</body>
    </html>
  );
}
