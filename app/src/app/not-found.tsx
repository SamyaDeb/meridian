import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ds";

export const metadata: Metadata = { title: "Not found · Meridian" };

/** App 404 in the card shell. Next's built-in 404 injects `body { background: #fff }`, which broke the dark theme and
 *  the footer link's contrast (axe color-contrast 3.17:1). */
export default function NotFound() {
  return (
    <Card as="section" className="mx-auto mt-6 max-w-md" bodyClassName="flex flex-col items-center gap-3 py-8 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="max-w-[320px] text-sm text-muted">This page doesn&apos;t exist.</p>
      <Link href="/trade" className="inline-flex min-h-11 items-center text-sm text-brand-soft underline">
        Go to Trade
      </Link>
    </Card>
  );
}
