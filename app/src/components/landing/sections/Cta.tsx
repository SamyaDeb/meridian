import Link from "next/link";
import TypeLine from "@/components/landing/TypeLine";

export default function Cta() {
  return (
    <section style={{ background: "#fff", color: "#0e100f", fontFamily: "var(--font-inter-tight),Helvetica,sans-serif", padding: "40px 20px 140px", display: "flex", justifyContent: "center" }}>
      <div data-up="1" data-d="0" style={{ position: "relative", overflow: "hidden", width: "100%", maxWidth: "1310px", borderRadius: "44px", background: "linear-gradient(180deg,#e6e3f6 0%,#bdb5e7 55%,#836ef9 100%)", padding: "clamp(70px,8vw,120px) 24px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        <svg aria-hidden="true" style={{ position: "absolute", left: "-40px", top: "50%", marginTop: "-110px", width: "220px", height: "220px", opacity: "0.35", pointerEvents: "none" }} viewBox="0 0 200 200" fill="none" stroke="#6e5fc1" strokeWidth="2.2" strokeLinecap="round"><path d="M40 150a70 70 0 0 1 120-90" /><path d="M55 160a55 55 0 0 1 95-85" /><path d="M70 168a42 42 0 0 1 72-72" /><path d="M86 172a28 28 0 0 1 48-50" /><path d="M100 176a14 14 0 0 1 22-26" /><path d="M168 80a70 70 0 0 1 2 60" /><path d="M155 95a55 55 0 0 1 0 45" /></svg>
        <svg aria-hidden="true" style={{ position: "absolute", right: "-40px", top: "50%", marginTop: "-110px", transform: "scaleX(-1)", width: "220px", height: "220px", opacity: "0.35", pointerEvents: "none" }} viewBox="0 0 200 200" fill="none" stroke="#6e5fc1" strokeWidth="2.2" strokeLinecap="round"><path d="M40 150a70 70 0 0 1 120-90" /><path d="M55 160a55 55 0 0 1 95-85" /><path d="M70 168a42 42 0 0 1 72-72" /><path d="M86 172a28 28 0 0 1 48-50" /><path d="M100 176a14 14 0 0 1 22-26" /><path d="M168 80a70 70 0 0 1 2 60" /><path d="M155 95a55 55 0 0 1 0 45" /></svg>
        <h2 data-type="1" style={{ position: "relative", margin: "0", fontSize: "clamp(34px,4.2vw,60px)", lineHeight: "1.1", fontWeight: "600", letterSpacing: "-0.045em", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <TypeLine text="Trade the Rate." />
          <TypeLine text="Every Block." />
        </h2>
        <p data-tp="1" style={{ position: "relative", margin: "26px 0 0", fontSize: "clamp(15px,1.2vw,18px)", lineHeight: "1.5", color: "#271247", letterSpacing: "-0.01em" }}>MON-PERP, the basis vault and funding swaps. All in AUSD, on Monad.</p>
        <Link href="/trade" data-up="1" data-d="900" style={{ position: "relative", marginTop: "44px", background: "#a08ffb", color: "#0e100f", borderRadius: "999px", padding: "20px 44px", fontSize: "17px", fontWeight: "600", letterSpacing: "-0.02em", boxShadow: "0 0 0 4px rgba(255,255,255,.55)" }} className="hover-primary">Launch App</Link>
      </div>
    </section>
  );
}
