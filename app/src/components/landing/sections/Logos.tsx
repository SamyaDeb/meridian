import { logos } from "@/components/landing/data";

export default function Logos() {
  return (
    <section style={{ background: "#fff", color: "#0e100f", fontFamily: "var(--font-inter-tight),Helvetica,sans-serif", padding: "40px 20px 120px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ fontSize: "18px", color: "#3a3a3a", letterSpacing: "-0.01em" }}>Built with</div>
      <div style={{ width: "100%", maxWidth: "1310px", marginTop: "48px", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,200px),1fr))", gap: "12px" }}>
        {logos.map((l, i) => (
          <div key={i} data-rise="1" style={{ height: "100px", borderRadius: "30px", background: "#eceaf4", display: "flex", alignItems: "center", justifyContent: "center", color: "#8c918e", fontSize: "24px", fontWeight: "700", letterSpacing: `${l.ls}` }}>{l.t}</div>
        ))}
      </div>
    </section>
  );
}
