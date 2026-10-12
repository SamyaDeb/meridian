import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Gallery } from "./Gallery";

export const metadata: Metadata = { title: "Design system · Meridian", robots: { index: false } };

/** Dev-only component gallery (FRONTEND_TRADE_PLAN F0.3). 404 in production unless NEXT_PUBLIC_DESIGN_PAGE=1 (review builds). */
export default function DesignPage() {
  if (process.env.NODE_ENV !== "development" && process.env.NEXT_PUBLIC_DESIGN_PAGE !== "1") notFound();
  return <Gallery />;
}
