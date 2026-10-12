import TypeLine from "@/components/landing/TypeLine";
import { dashRows } from "@/components/landing/data";

export default function Features() {
  return (
    <section style={{ background: "#fff", color: "#0e100f", fontFamily: "var(--font-inter-tight),Helvetica,sans-serif", padding: "120px 20px 180px", overflow: "hidden", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
      <h2 data-type="1" style={{ margin: "0", fontSize: "clamp(34px,4.2vw,60px)", lineHeight: "1.1", fontWeight: "600", letterSpacing: "-0.04em", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <TypeLine text="The Funding-Rate Layer" />
        <TypeLine text="Built for Monad" />
      </h2>
      <p data-tp="1" style={{ margin: "40px 0 0", maxWidth: "540px", fontSize: "clamp(16px,1.3vw,19px)", lineHeight: "1.5", color: "#3a3a3a", letterSpacing: "-0.01em", textWrap: "pretty" }}>A per-block funding perp, a public funding-rate oracle, a basis vault and fixed-rate funding swaps. All in AUSD.</p>
      <div style={{ width: "100%", maxWidth: "1310px", marginTop: "70px", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,480px),1fr))", gap: "30px", textAlign: "left", perspective: "1400px" }}>
        <div data-scroll="left" style={{ background: "#eceaf4", borderRadius: "44px", padding: "56px 48px 0", height: "552px", display: "flex", flexDirection: "column", overflow: "hidden", willChange: "transform,opacity" }}>
          <div style={{ fontSize: "36px", fontWeight: "600", letterSpacing: "-0.04em" }}>Per-Block Funding Perp</div>
          <div style={{ fontSize: "17px", color: "#3a3a3a", marginTop: "18px" }}>MON-PERP up to 5x on a fully onchain order book.</div>
          <div style={{ flex: "1", background: "#fff", borderRadius: "30px 30px 0 0", marginTop: "52px", padding: "36px 34px 0", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ fontSize: "20px", fontWeight: "600", letterSpacing: "-0.01em" }}>Funding this block</div>
            <div style={{ fontSize: "52px", fontWeight: "700", letterSpacing: "-0.01em", marginTop: "22px" }}>$ 287.65</div>
            <div style={{ position: "relative", flex: "1", marginTop: "14px" }}>
              <div style={{ position: "absolute", left: "0", top: "44px", fontSize: "12px" }}>2025</div>
              <div style={{ position: "absolute", left: "0", top: "106px", fontSize: "12px" }}>2023</div>
              <div style={{ position: "absolute", left: "0", top: "168px", fontSize: "12px" }}>2020</div>
              <div style={{ position: "absolute", left: "40px", right: "24px", top: "52px", height: "1px", background: "#ececec" }}></div>
              <div style={{ position: "absolute", left: "40px", right: "24px", top: "114px", height: "1px", background: "#ececec" }}></div>
              <div style={{ position: "absolute", left: "calc(40px + (100% - 64px) * 0.368 - 10px)", top: "44px", width: "20px", bottom: "0", background: "linear-gradient(180deg,#836ef9,rgba(157,145,222,0))" }}></div>
              <div style={{ position: "absolute", left: "calc(40px + (100% - 64px) * 0.368)", transform: "translateX(-50%)", top: "0", background: "linear-gradient(135deg,#836ef9,#b6acec)", borderRadius: "8px", padding: "7px 8px", fontSize: "12px", fontWeight: "600" }}>89.75%</div>
              <svg style={{ position: "absolute", left: "40px", right: "24px", top: "36px", width: "calc(100% - 64px)", height: "140px", overflow: "visible" }} viewBox="0 0 680 280" preserveAspectRatio="none" fill="none">
                <defs><linearGradient id="wg" x1="0" x2="1"><stop offset="0" stopColor="#836ef9" /><stop offset="1" stopColor="#bbb2ec" /></linearGradient></defs>
                <path data-draw="1" d="M0 280 C110 250 190 170 250 40 C290 -10 300 200 360 205 C400 208 430 110 470 110 C520 110 540 215 590 210 C630 206 640 160 680 160" stroke="url(#wg)" strokeWidth="7" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
              <div style={{ position: "absolute", left: "calc(40px + (100% - 64px) * 0.368 - 6px)", top: "48px", width: "12px", height: "12px", borderRadius: "50%", background: "#0e100f", border: "2px solid #fff" }}></div>
            </div>
          </div>
        </div>
        <div data-scroll="right" style={{ background: "#eceaf4", borderRadius: "44px", padding: "56px 48px 0", height: "552px", display: "flex", flexDirection: "column", overflow: "hidden", willChange: "transform,opacity" }}>
          <div style={{ fontSize: "36px", fontWeight: "600", letterSpacing: "-0.04em" }}>Smart Risk Management</div>
          <div style={{ fontSize: "17px", color: "#3a3a3a", marginTop: "18px" }}>Anyone can liquidate an account below maintenance margin; an insurance fund covers bad debt.</div>
          <div style={{ flex: "1", background: "#fff", borderRadius: "30px 30px 0 0", marginTop: "52px", padding: "36px 34px 34px", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
              <div><div style={{ fontSize: "22px", fontWeight: "600", letterSpacing: "-0.02em" }}>Funding Index</div><div style={{ fontSize: "13px", marginTop: "4px" }}>Updated every block</div></div>
              <div style={{ display: "flex", alignItems: "center", gap: "14px", border: "1px solid #dcdcdc", borderRadius: "999px", padding: "9px 14px", fontSize: "13px", fontWeight: "600" }}>Live <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"><polyline points="2,4 6,8 10,4" /></svg></div>
            </div>
            <div style={{ flex: "1", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "12px", marginTop: "20px" }}>
              <div><div style={{ fontSize: "12px" }}>Open interest</div><div style={{ fontSize: "32px", fontWeight: "600", letterSpacing: "-0.02em", marginTop: "6px" }}>26,954</div></div>
              <div style={{ display: "flex", gap: "7px", height: "100%", maxHeight: "210px" }}>
                <div style={{ width: "108px", borderRadius: "16px", background: "repeating-linear-gradient(-30deg,#f3f3f3 0 6px,#fff 6px 12px)", display: "flex", flexDirection: "column", justifyContent: "space-between", overflow: "hidden" }}>
                  <div style={{ fontSize: "10px", padding: "10px 10px 0" }}>September</div>
                  <div data-bar="1" style={{ height: "58%", borderRadius: "16px", background: "linear-gradient(180deg,#836ef9 0 22%,#aea4e7 22%)", transformOrigin: "bottom" }}></div>
                </div>
                <div style={{ width: "108px", borderRadius: "16px", background: "repeating-linear-gradient(-30deg,#f3f3f3 0 6px,#fff 6px 12px)", display: "flex", flexDirection: "column", justifyContent: "space-between", overflow: "hidden" }}>
                  <div style={{ fontSize: "10px", padding: "10px 10px 0" }}>December</div>
                  <div data-bar="1" style={{ height: "78%", borderRadius: "16px", background: "linear-gradient(180deg,#836ef9 0 67%,#aea4e7 67%)", transformOrigin: "bottom" }}></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ width: "100%", maxWidth: "1310px", marginTop: "60px", perspective: "1200px", textAlign: "left" }}>
        <div data-scroll="tilt" style={{ background: "#eceaf4", borderRadius: "40px", padding: "36px 44px 36px 56px", minHeight: "410px", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,380px),1fr))", alignItems: "center", gap: "30px", transformOrigin: "50% 50%", willChange: "transform" }}>
          <div>
            <div style={{ fontSize: "36px", fontWeight: "600", letterSpacing: "-0.04em", lineHeight: "1.12" }}>A Public Funding-Rate Oracle</div>
            <div style={{ fontSize: "16px", color: "#3a3a3a", marginTop: "18px", lineHeight: "1.55", maxWidth: "300px" }}>Realized 1 h, 8 h and 24 h funding APR onchain, for anyone to read or settle against.</div>
          </div>
          <div style={{ position: "relative", background: "#fff", borderRadius: "6px", height: "338px", marginLeft: "90px", padding: "14px 10px 10px 16px", display: "flex", gap: "12px" }}>
            <div style={{ width: "80px", flex: "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: "600" }}><div style={{ width: "15px", height: "15px", borderRadius: "4px", background: "linear-gradient(135deg,#836ef9,#b9b0ea)" }}></div>Meridian</div>
            </div>
            <div style={{ flex: "1", background: "#f5f5f9", borderRadius: "4px", padding: "12px 12px", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", gap: "14px", fontSize: "6px", color: "#8a8a8a", paddingBottom: "8px", borderBottom: "1px solid #dfddec" }}>
                <span>Trade</span><span style={{ color: "#0e100f", fontWeight: "600" }}>Rates</span><span>Earn</span><span>Fix</span><span>Stats</span>
              </div>
              <div style={{ flex: "1", display: "flex", flexDirection: "column", justifyContent: "space-around" }}>
                {dashRows.map((row, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: "16px", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}><div style={{ width: "14px", height: "14px", borderRadius: "50%", background: "#dbd8ea" }}></div><div style={{ width: "44px", height: "5px", borderRadius: "3px", background: "#cdc9e2" }}></div></div>
                    <div style={{ height: "5px", borderRadius: "3px", background: "#c1bcdb" }}></div>
                    <div style={{ height: "5px", borderRadius: "3px", background: `${row.c}` }}></div>
                    <div style={{ height: "5px", borderRadius: "3px", background: "#c1bcdb" }}></div>
                  </div>
                ))}
              </div>
            </div>
            <div data-pop="1" style={{ position: "absolute", left: "-54px", top: "82px", width: "252px", background: "#fff", border: "3px solid #eeedf5", borderRadius: "10px", padding: "10px 10px 14px", boxShadow: "0 20px 50px rgba(115,98,213,0.28)" }}>
              <div style={{ display: "flex", gap: "14px", fontSize: "7px", fontWeight: "600", paddingBottom: "8px", borderBottom: "1px solid #dfddec" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "4px" }}><span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#836ef9" }}></span>LONGS</span>
                <span style={{ display: "flex", alignItems: "center", gap: "4px" }}><span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#a69ce1" }}></span>SHORTS</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "26px" }}>
                <span style={{ fontSize: "18px", fontWeight: "600", color: "#180b2c" }}>258 <span style={{ fontSize: "8px", fontWeight: "600" }}>Open Interest</span></span>
                <span style={{ fontSize: "10px", fontWeight: "600" }}>Right Now</span>
              </div>
              <div style={{ height: "18px", borderRadius: "9px", background: "#aba0ea", marginTop: "12px", overflow: "hidden" }}><div data-bar-x="1" style={{ height: "100%", width: "83%", background: "#836ef9", borderRadius: "9px 0 0 9px", transformOrigin: "left" }}></div></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
