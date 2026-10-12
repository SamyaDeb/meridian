import TypeLine from "@/components/landing/TypeLine";
import RollNumber from "@/components/landing/RollNumber";
import { stats } from "@/components/landing/data";

export default function WhyChooseUs() {
  return (
    <section style={{ background: "#fff", color: "#0e100f", fontFamily: "var(--font-inter-tight),Helvetica,sans-serif", padding: "60px 20px 140px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
      <h2 data-type="1" style={{ margin: "0", fontSize: "clamp(34px,4.2vw,60px)", lineHeight: "1.1", fontWeight: "600", letterSpacing: "-0.04em" }}>
        <TypeLine text="Why Monad?" />
      </h2>
      <p data-tp="1" style={{ margin: "28px 0 0", maxWidth: "420px", fontSize: "clamp(16px,1.3vw,19px)", lineHeight: "1.5", color: "#3a3a3a", letterSpacing: "-0.01em", textWrap: "pretty" }}>Hourly funding exists because chains were slow. On Monad, funding is continuous.</p>
      <div style={{ width: "100%", maxWidth: "1310px", marginTop: "40px", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))", gap: "30px", textAlign: "left" }}>
        {stats.map((s, i) => (
          <div key={i} data-stat-card="1" style={{ border: "1px solid #d1cee4", borderRadius: "40px", padding: "40px 40px 44px", minHeight: "300px" }}>
            <div data-pill="1" style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "3px 16px 3px 3px", borderRadius: "999px", background: "linear-gradient(90deg,#836ef9,rgba(141,127,218,0.15))", fontSize: "15px", fontWeight: "600", letterSpacing: "-0.02em" }}>
              <div style={{ width: "26px", height: "26px", borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#0e100f" strokeWidth="1.6"><circle cx="6" cy="5" r="2.5" /><path d="M1.5 13c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" /><path d="M11 3a2.3 2.3 0 0 1 0 4.5M12.5 9.5c1.3.5 2 1.7 2 3.5" /></svg></div>
              {s.label}
            </div>
            <div style={{ display: "flex", alignItems: "flex-start", marginTop: "30px", fontWeight: "600", letterSpacing: "-0.04em", lineHeight: "1" }}>
              <RollNumber n={s.n} style={{ fontSize: "64px", display: "inline-flex" }} /><span style={{ fontSize: "64px" }}>{s.unit}</span><span style={{ fontSize: "34px", marginLeft: "2px" }}>{s.sup}</span>
            </div>
            <div data-fade="1" style={{ fontSize: "16px", lineHeight: "1.55", color: "#3a3a3a", marginTop: "34px", maxWidth: "270px" }}>{s.desc}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
