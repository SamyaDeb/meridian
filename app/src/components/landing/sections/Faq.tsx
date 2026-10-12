"use client";

import { useState } from "react";
import TypeLine from "@/components/landing/TypeLine";
import { faqs } from "@/components/landing/data";

export default function Faq() {
  const [open, setOpen] = useState(-1);

  return (
    <section style={{ background: "#fff", color: "#0e100f", fontFamily: "var(--font-inter-tight),Helvetica,sans-serif", padding: "60px 20px 120px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
      <h2 data-type="1" style={{ margin: "0", fontSize: "clamp(34px,4.2vw,60px)", lineHeight: "1.1", fontWeight: "600", letterSpacing: "-0.045em" }}>
        <TypeLine text="Frequently asked questions" />
      </h2>
      <p data-tp="1" style={{ margin: "22px 0 0", fontSize: "clamp(14px,1.1vw,16px)", lineHeight: "1.5", color: "#3a3a3a", letterSpacing: "-0.01em" }}>Funding, the vault and swaps in plain words.</p>
      <div style={{ width: "100%", maxWidth: "860px", marginTop: "60px", display: "flex", flexDirection: "column", gap: "22px", textAlign: "left" }}>
        {faqs.map((f, i) => (
          <div key={i} data-up="1" data-d={i * 120} style={{ border: "1px solid #dfddec", borderRadius: "24px", background: "#fff" }}>
            <button type="button" aria-expanded={open === i} onClick={() => setOpen((o) => (o === i ? -1 : i))} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "20px", padding: "32px 36px" }}>
              <span style={{ fontSize: "clamp(17px,1.6vw,23px)", fontWeight: "600", letterSpacing: "-0.035em", color: "#0e100f" }}>{f.q}</span>
              <span style={{ flex: "none", width: "22px", height: "22px", borderRadius: "6px", background: "#836ef9", display: "flex", alignItems: "center", justifyContent: "center", transition: "transform .35s cubic-bezier(.3,.7,.2,1)", transform: open === i ? "rotate(45deg)" : "none" }}><svg width="12" height="12" viewBox="0 0 12 12" stroke="#0e100f" strokeWidth="1.8" strokeLinecap="round"><path d="M6 1.5v9M1.5 6h9" /></svg></span>
            </button>
            <div style={{ display: "grid", gridTemplateRows: open === i ? "1fr" : "0fr", transition: "grid-template-rows .45s cubic-bezier(.3,.7,.2,1)" }}>
              <div style={{ overflow: "hidden" }}>
                <p style={{ margin: "0", padding: "0 36px 32px", maxWidth: "640px", fontSize: "17px", lineHeight: "1.55", color: "#3a3a3a", letterSpacing: "-0.01em" }}>{f.a}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
