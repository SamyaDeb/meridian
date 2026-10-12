import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ds";

export const metadata: Metadata = { title: "Not available · Meridian" };

export default function BlockedPage() {
  return (
    <Card as="section" className="mx-auto mt-6 max-w-md" bodyClassName="flex flex-col items-center gap-3 py-8 text-center">
      <h1 className="text-xl font-semibold">Meridian isn&apos;t available in your region</h1>
      <p className="max-w-[320px] text-sm text-muted">Access from your location is restricted. This is based on where your connection comes from.</p>
      <Link href="/terms" className="inline-flex min-h-11 items-center text-sm text-brand-soft underline">
        Terms of use
      </Link>
    </Card>
  );
}
