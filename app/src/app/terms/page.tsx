import type { Metadata } from "next";
import { Card, Notice } from "@/components/ds";
import { TERMS_SECTIONS, TERMS_STATUS, TERMS_SUMMARY } from "@/content/terms";
import { TERMS_VERSION } from "@/lib/terms";

export const metadata: Metadata = { title: "Terms · Meridian" };

export default function TermsPage() {
  return (
    <Card as="div" className="my-2">
    <article className="space-y-4 text-sm leading-relaxed">
      <header>
        <h1 className="text-xl font-semibold">Terms of use and risk disclosure</h1>
        <p className="num text-[11px] text-muted">version {TERMS_VERSION}</p>
        {TERMS_STATUS === "draft" && (
          <Notice tone="warn" className="mt-2">
            Draft: pending sign-off by all three founders. Not legal advice.
          </Notice>
        )}
      </header>
      <section className="rounded-inner bg-card-2 p-4">
        <h2 className="mb-2 text-sm font-medium text-muted">In short</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          {TERMS_SUMMARY.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </section>
      {TERMS_SECTIONS.map((s) => (
        <section key={s.heading}>
          <h2 className="mb-1 font-semibold">{s.heading}</h2>
          {s.body.map((p) => (
            <p key={p} className="mb-2 text-muted">
              {p}
            </p>
          ))}
        </section>
      ))}
    </article>
    </Card>
  );
}
