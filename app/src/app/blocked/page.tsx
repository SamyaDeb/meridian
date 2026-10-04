import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not available · Pulse" };

export default function BlockedPage() {
  return (
    <section className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 text-center">
      <h1 className="text-xl font-semibold">Pulse isn&apos;t available in your region</h1>
      <p className="max-w-[320px] text-sm text-muted">Access from your location is restricted. This is based on where your connection comes from.</p>
      <Link href="/terms" className="text-sm text-accent underline">
        Terms of use
      </Link>
    </section>
  );
}
