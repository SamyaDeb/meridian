import Image from "next/image";
import Link from "next/link";
import { footLinks, footResources, prismFaces } from "@/components/landing/data";

export default function Footer() {
  return (
    <footer style={{ background: "#0e100f", color: "#fff", fontFamily: "var(--font-inter-tight),Helvetica,sans-serif", padding: "80px clamp(20px,4vw,60px) 40px", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))", gap: "48px" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "48px" }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: "12px", color: "#fff", textDecoration: "none", fontSize: "26px", fontWeight: "600", letterSpacing: "-0.03em" }}>
            <Image src="/landing/logo.png" alt="" width={40} height={40} style={{ display: "block" }} priority />
            Meridian
          </Link>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: "32px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <div style={{ fontSize: "17px", fontWeight: "600", marginBottom: "10px" }}>App</div>
            {footLinks.map((m) => (<Link key={m.h} href={m.h} style={{ color: "#d4d4d4", textDecoration: "none", fontSize: "15px" }}>{m.l}</Link>))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <div style={{ fontSize: "17px", fontWeight: "600", marginBottom: "10px" }}>Resources</div>
            {footResources.map((m) => (<a key={m.h} href={m.h} {...(m.h.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})} style={{ color: "#d4d4d4", textDecoration: "none", fontSize: "15px" }}>{m.l}</a>))}
          </div>
        </div>
      </div>
      <div style={{ position: "relative", marginTop: "60px", display: "flex", alignItems: "flex-end", gap: "40px", flexWrap: "wrap" }}>
        <div data-roll3d="1" style={{ flex: "1", minWidth: "280px", height: "clamp(110px,15vw,230px)", perspective: "1400px", display: "flex", justifyContent: "flex-end" }}>
          <div data-prism="1" style={{ position: "relative", width: "100%", height: "100%", transformStyle: "preserve-3d" }}>
            {prismFaces.map((p, i) => (
              <div key={i} style={{ position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "flex-end", backfaceVisibility: "hidden", transform: `rotateX(${p.r}deg) translateZ(calc(clamp(110px,15vw,230px) / 2))` }}>
                <span style={{ fontSize: "clamp(120px,17vw,270px)", lineHeight: ".8", fontWeight: "700", letterSpacing: "-0.04em", background: "linear-gradient(180deg,#4a4a4a 0%,#2a2a2a 55%,#111 100%)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>Meridian</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
