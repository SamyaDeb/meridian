import TypeLine from "@/components/landing/TypeLine";
import { tiles } from "@/components/landing/data";

export default function SendReceiveSwap() {
  return (
    <section style={{ overflowX: "clip", background: "#fff", color: "#0e100f", fontFamily: "var(--font-inter-tight),Helvetica,sans-serif", padding: "40px 20px 140px", display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: "1310px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,460px),1fr))", gap: "40px 120px", alignItems: "start" }}>
          <h2 data-type="1" style={{ margin: "0", fontSize: "clamp(34px,4.2vw,58px)", lineHeight: "1.08", fontWeight: "600", letterSpacing: "-0.045em", display: "flex", flexDirection: "column" }}>
            <TypeLine text="Pay Fixed. Receive Floating." />
            <TypeLine text="Or the other way round." />
          </h2>
          <p data-tp="1" style={{ margin: "22px 0 0", fontSize: "clamp(16px,1.3vw,19px)", lineHeight: "1.5", color: "#3a3a3a", letterSpacing: "-0.01em", textWrap: "pretty" }}>Funding swaps turn floating funding into a fixed APR until maturity, so a hedger knows the cost and a basis trader locks the carry.</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,460px),1fr))", gap: "60px 120px", marginTop: "80px", alignItems: "center" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "56px 40px" }}>
            {tiles.map((t, i) => (
              <div key={i} data-scroll="tile" data-i={i}>
                <div style={{ aspectRatio: "1/0.96", border: "1px solid #dfddec", borderRadius: "20px", background: "#fff", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "16px", willChange: "transform" }}>
                  <svg width="38" height="38" viewBox="0 0 24 24" fill="#8f9391" stroke="none"><path d={t.d} /></svg>
                  <span style={{ fontSize: "clamp(14px,1.25vw,17px)", fontWeight: "500", letterSpacing: "-0.02em" }}>{t.label}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ position: "relative", height: "560px", borderRadius: "44px", background: "linear-gradient(180deg,#f5f4f9 0%,#cdc7ed 45%,#836ef9 100%)" }}>
            <div style={{ position: "absolute", inset: "0", clipPath: "inset(-120px -900px 0 -900px round 0 0 44px 44px)", pointerEvents: "none" }}>
            <div data-scroll="phone" style={{ position: "absolute", left: "50%", top: "56px", width: "340px", marginLeft: "-170px", height: "640px", border: "10px solid #151515", borderRadius: "56px", background: "#fff", boxShadow: "0 0 0 2px #3a3a3a", willChange: "transform" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 26px 0", fontSize: "15px", fontWeight: "600", fontFamily: "Helvetica,sans-serif" }}>
                <span>19:02</span>
                <div style={{ width: "96px", height: "28px", borderRadius: "20px", background: "#0e100f" }}></div>
                <div style={{ display: "flex", gap: "4px", alignItems: "center" }}><div style={{ width: "16px", height: "9px", background: "#0e100f", borderRadius: "2px" }}></div><div style={{ width: "22px", height: "10px", background: "#0e100f", borderRadius: "3px" }}></div></div>
              </div>
              <div style={{ display: "flex", alignItems: "center", padding: "26px 20px 0", fontFamily: "Helvetica,sans-serif" }}>
                <div style={{ width: "50px", height: "50px", borderRadius: "14px", background: "#e8e6f5", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="#0e100f" strokeWidth="1.5"><path d="M13 8H3M7 4L3 8l4 4" /></svg></div>
                <span style={{ flex: "1", textAlign: "center", marginRight: "50px", fontSize: "19px", fontWeight: "600" }}>Funding Swap</span>
              </div>
              <div style={{ margin: "30px 20px 0", borderRadius: "18px", background: "linear-gradient(180deg,#c1baea,#e6e3f6)", padding: "26px 20px 24px", fontFamily: "Helvetica,sans-serif" }}>
                <div style={{ fontSize: "12px", color: "#666" }}>You Pay (fixed)</div>
                <div style={{ fontSize: "21px", fontWeight: "700", marginTop: "8px" }}>8.00% APR</div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "22px 0" }}><div style={{ flex: "1", height: "1px", background: "#a29bc9" }}></div><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0e100f" strokeWidth="1.5"><path d="M8 20V4L4 8M16 4v16l4-4" /></svg><div style={{ flex: "1", height: "1px", background: "#a29bc9" }}></div></div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                  <div><div style={{ fontSize: "12px", color: "#666" }}>You Receive (floating)</div><div style={{ fontSize: "21px", fontWeight: "700", marginTop: "8px" }}>Funding</div></div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "15px", fontWeight: "600" }}><div style={{ width: "28px", height: "28px", borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px" }}>◆</div>MON-PERP</div>
                </div>
                <div style={{ textAlign: "center", fontSize: "12px", color: "#555", marginTop: "26px" }}>● 30-day maturity · settled in AUSD</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: "12px", margin: "18px 20px 0", fontFamily: "Helvetica,sans-serif" }}>
                <div style={{ borderRadius: "14px", background: "#e4e1f4", padding: "14px", display: "flex", gap: "10px", alignItems: "center" }}><div style={{ width: "26px", height: "26px", borderRadius: "50%", background: "#836ef9" }}></div><div><div style={{ fontSize: "11px", color: "#666" }}>Notional</div><div style={{ fontSize: "14px", fontWeight: "600" }}>1,000 AUSD</div></div></div>
                <div style={{ borderRadius: "14px", background: "#faeedd", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "19px", fontWeight: "700" }}>30 d</div>
              </div>
            </div>
            </div>
            <div style={{ position: "absolute", right: "6%", top: "160px", width: "240px", background: "#fff", borderRadius: "20px", padding: "16px 18px", boxShadow: "0 20px 40px rgba(35,16,64,0.12)", fontFamily: "Helvetica,sans-serif" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", fontWeight: "600" }}><span>Funding APR</span><span style={{ fontWeight: "500" }}>live</span></div>
              <svg viewBox="0 0 200 50" style={{ width: "100%", height: "50px", marginTop: "10px" }} fill="none" stroke="#836ef9" strokeWidth="1.8"><path data-draw="1" d="M0 44 C12 40 20 18 34 12 S48 30 60 26 S80 30 94 30 S112 34 126 30 S150 24 162 26 S182 34 200 44" /></svg>
            </div>
            <div style={{ position: "absolute", left: "8%", top: "310px", width: "168px", background: "#fff", borderRadius: "20px", padding: "18px 20px", boxShadow: "0 20px 40px rgba(35,16,64,0.12)", fontFamily: "Helvetica,sans-serif" }}>
              <div style={{ fontSize: "14px", fontWeight: "600" }}>Counterparties</div>
              <div style={{ display: "flex", alignItems: "center", marginTop: "14px" }}>
                <div style={{ width: "28px", height: "28px", borderRadius: "50%", border: "2px solid #fff", background: "linear-gradient(135deg,#2c2420,#8a6650)" }}></div>
                <div style={{ width: "28px", height: "28px", borderRadius: "50%", border: "2px solid #fff", marginLeft: "-8px", background: "linear-gradient(135deg,#5a4538,#d2a986)" }}></div>
                <div style={{ width: "28px", height: "28px", borderRadius: "50%", border: "2px solid #fff", marginLeft: "-8px", background: "linear-gradient(135deg,#3b2a22,#a07458)" }}></div>
                <div style={{ width: "30px", height: "30px", borderRadius: "50%", background: "#836ef9", marginLeft: "12px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px" }}>+</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
