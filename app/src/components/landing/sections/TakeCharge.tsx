import TypeLine from "@/components/landing/TypeLine";
import Link from "next/link";

export default function TakeCharge() {
  return (
    <section style={{ background: "#fff", color: "#0e100f", fontFamily: "var(--font-inter-tight),Helvetica,sans-serif", padding: "60px 20px 120px", display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: "1310px", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,500px),1fr))", gap: "clamp(40px,7vw,100px)", alignItems: "center" }}>
        <div style={{ background: "#eceaf4", borderRadius: "44px", padding: "44px 50px", display: "flex", flexDirection: "column", gap: "22px", transformOrigin: "50% 100%", willChange: "transform" }}>
          <div data-layer="1" style={{ background: "#fff", borderRadius: "38px", overflow: "hidden", willChange: "transform" }}>
            <div style={{ padding: "36px 30px 34px" }}>
              <div style={{ fontSize: "24px", fontWeight: "600", letterSpacing: "-0.025em" }}>Funding Summary</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "10px", marginTop: "34px", fontSize: "18px", color: "#555", letterSpacing: "-0.01em" }}>
                <span>Paid</span><span>Received</span><span>Add</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "10px", marginTop: "18px", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
                  <div style={{ width: "40px", height: "40px", borderRadius: "10px", background: "linear-gradient(180deg,#836ef9,#b6acec)", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#0e100f" strokeWidth="1.6"><path d="M8 13V3M4 7l4-4 4 4" /></svg></div>
                  <span style={{ fontSize: "22px", fontWeight: "500", letterSpacing: "-0.02em" }}>$ <span data-count="3695.06" data-dec="2">0.00</span></span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
                  <div style={{ width: "40px", height: "40px", borderRadius: "10px", background: "linear-gradient(180deg,#836ef9,#b6acec)", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#0e100f" strokeWidth="1.6"><path d="M8 3v10M4 9l4 4 4-4" /></svg></div>
                  <span style={{ fontSize: "22px", fontWeight: "500", letterSpacing: "-0.02em" }}>$ <span data-count="95295.06" data-dec="2">0.00</span></span>
                </div>
                <div style={{ width: "40px", height: "40px", borderRadius: "10px", background: "linear-gradient(180deg,#836ef9,#b6acec)", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#0e100f" strokeWidth="1.8"><path d="M8 3v10M3 8h10" /></svg></div>
              </div>
            </div>
            <div style={{ borderTop: "1px solid #d1cee4", padding: "30px 20px 26px" }}>
              <div data-layer="2" style={{ position: "relative", background: "#eceaf4", borderRadius: "30px", padding: "48px 40px 26px", willChange: "transform" }}>
                <div style={{ position: "absolute", left: "50%", top: "0", transform: "translateX(-50%)", background: "#fff", borderRadius: "0 0 16px 16px", padding: "0 20px 8px", display: "flex", alignItems: "center", gap: "10px", fontSize: "14px", fontWeight: "600", letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
                  <span style={{ color: "#836ef9", fontSize: "13px" }}>●</span>Funding swap
                </div>
                <div style={{ fontSize: "14.5px", lineHeight: "1.6", color: "#444", textWrap: "pretty" }}>Pay fixed, receive floating: a perp long knows its funding cost until maturity, whatever the market does.</div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "18px" }}>
                  <div style={{ width: "34px", height: "34px", borderRadius: "50%", background: "linear-gradient(135deg,#6b4a3a,#c79a78)" }}></div>
                  <span style={{ fontSize: "15px", fontWeight: "600", letterSpacing: "-0.01em" }}>Long swap · 30-day maturity</span>
                </div>
              </div>
            </div>
          </div>
          <div data-layer="3" style={{ background: "#fff", borderRadius: "30px", padding: "14px 30px 14px 14px", display: "flex", alignItems: "center", gap: "14px", willChange: "transform" }}>
            <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "linear-gradient(180deg,#836ef9,#b6acec)", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#0e100f" strokeWidth="1.5"><path d="M2 6h11l-3-3M14 10H3l3 3" /></svg></div>
            <span style={{ flex: "1", fontSize: "20px", fontWeight: "600", letterSpacing: "-0.025em" }}>Recent Funding</span>
            <div style={{ display: "flex" }}>
              <div style={{ width: "32px", height: "32px", borderRadius: "50%", border: "2px solid #fff", background: "linear-gradient(135deg,#3b2a22,#a07458)" }}></div>
              <div style={{ width: "32px", height: "32px", borderRadius: "50%", border: "2px solid #fff", marginLeft: "-8px", background: "linear-gradient(135deg,#5a4538,#d2a986)" }}></div>
              <div style={{ width: "32px", height: "32px", borderRadius: "50%", border: "2px solid #fff", marginLeft: "-8px", background: "linear-gradient(135deg,#2c2420,#8a6650)" }}></div>
            </div>
          </div>
        </div>
        <div style={{ position: "relative", minWidth: "0", display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <h2 data-type="1" style={{ margin: "0", fontSize: "clamp(30px,3.3vw,48px)", lineHeight: "1.12", fontWeight: "600", letterSpacing: "-0.035em", display: "flex", flexDirection: "column", maxWidth: "100%" }}>
            <TypeLine text="Earn the funding," />
            <TypeLine text="or fix it." />
          </h2>
          <p data-tp="1" style={{ margin: "24px 0 0", fontSize: "clamp(16px,1.3vw,19px)", lineHeight: "1.5", color: "#3a3a3a", letterSpacing: "-0.01em", textWrap: "pretty" }}>Funding floats with the market. Take the floating side in the basis vault, or lock a fixed rate with a funding swap.</p>
          <div style={{ position: "relative", display: "flex", flexDirection: "column", width: "100%", marginTop: "40px" }}>
            <div data-rise="1" style={{ position: "relative", display: "flex", gap: "24px", paddingBottom: "32px", borderBottom: "1px solid #d1cee4" }}>
              <div style={{ flex: "none", width: "52px", height: "52px", borderRadius: "50%", background: "linear-gradient(180deg,#836ef9,#b6acec)", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="22" height="22" viewBox="0 0 24 24" fill="#0e100f"><path d="M12 3a9 9 0 1 0 9 9h-9z" /><circle cx="15.5" cy="8.5" r="3.5" fill="none" stroke="#0e100f" strokeWidth="1.6" /></svg></div>
              <div>
                <div style={{ fontSize: "24px", fontWeight: "600", letterSpacing: "-0.025em" }}>Floating Yield</div>
                <div style={{ fontSize: "17px", lineHeight: "1.55", color: "#3a3a3a", marginTop: "12px" }}>Deposit AUSD into the basis vault. Its share price rises with the funding it earns, accrued every block.</div>
              </div>
            </div>
            <div data-rise="1" style={{ position: "relative", display: "flex", gap: "24px", paddingTop: "32px" }}>
              <div style={{ flex: "none", width: "52px", height: "52px", borderRadius: "50%", background: "linear-gradient(180deg,#836ef9,#b6acec)", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0e100f" strokeWidth="2.2" strokeLinecap="round"><path d="M9 15l6-6M7 11l-2 2a3 3 0 0 0 4 4l2-2M17 13l2-2a3 3 0 0 0-4-4l-2 2M4 4l2 2M18 18l2 2" /></svg></div>
              <div>
                <div style={{ fontSize: "24px", fontWeight: "600", letterSpacing: "-0.025em" }}>Fixed Rate</div>
                <div style={{ fontSize: "17px", lineHeight: "1.55", color: "#3a3a3a", marginTop: "12px" }}>Lock a fixed funding APR to maturity: go long a swap to pay fixed, or short it to receive fixed.</div>
              </div>
            </div>
          </div>
          <Link href="/trade" data-rise="1" style={{ marginTop: "40px", background: "#a08ffb", color: "#0e100f", textDecoration: "none", borderRadius: "999px", padding: "20px 44px", fontSize: "18px", fontWeight: "600", letterSpacing: "-0.02em" }} className="hover-primary">Launch App</Link>
        </div>
      </div>
    </section>
  );
}
