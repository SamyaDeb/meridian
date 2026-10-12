import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Rates & Risk · Meridian",
  description: "Meridian vs Perpl funding on Monad, a Perpl position monitor with Perpl's own liquidation rule, Meridian's risk and a crash replay.",
};

export default function RatesLayout({ children }: { children: ReactNode }) {
  return children;
}
