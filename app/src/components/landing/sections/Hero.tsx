import IntroWord from "@/components/landing/IntroWord";
import Image from "next/image";
import Link from "next/link";

export default function Hero() {
  return (
    <section data-intro="pending" style={{ position: "relative", overflow: "hidden", background: "#000", fontFamily: "var(--font-inter-tight),Helvetica,sans-serif", color: "#fff", minHeight: "1300px" }}>

      <svg style={{ position: "absolute", left: "-150px", top: "330px", width: "300px", height: "300px", opacity: "0.5" }} viewBox="0 0 300 300" fill="none" stroke="#2a2a2a" strokeWidth="3">
        <circle cx="150" cy="150" r="30" strokeDasharray="120 40" />
        <circle cx="150" cy="150" r="50" strokeDasharray="200 60" />
        <circle cx="150" cy="150" r="70" strokeDasharray="260 80" />
        <circle cx="150" cy="150" r="90" strokeDasharray="330 90" />
        <circle cx="150" cy="150" r="110" strokeDasharray="420 100" />
        <circle cx="150" cy="150" r="130" strokeDasharray="500 120" />
      </svg>
      <svg style={{ position: "absolute", right: "-160px", top: "180px", width: "320px", height: "320px", opacity: "0.5", transform: "rotate(140deg)" }} viewBox="0 0 300 300" fill="none" stroke="#2a2a2a" strokeWidth="3">
        <circle cx="150" cy="150" r="30" strokeDasharray="120 40" />
        <circle cx="150" cy="150" r="50" strokeDasharray="200 60" />
        <circle cx="150" cy="150" r="70" strokeDasharray="260 80" />
        <circle cx="150" cy="150" r="90" strokeDasharray="330 90" />
        <circle cx="150" cy="150" r="110" strokeDasharray="420 100" />
        <circle cx="150" cy="150" r="130" strokeDasharray="500 120" />
      </svg>

      <header style={{ position: "relative", zIndex: "7", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "24px", maxWidth: "1440px", margin: "0 auto", padding: "34px clamp(20px,4.6vw,66px)" }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: "12px", color: "#fff" }}>
          <Image src="/landing/logo.png" alt="" width={44} height={44} style={{ display: "block" }} priority />
          <span style={{ fontSize: "29px", fontWeight: "600", letterSpacing: "-0.03em" }}>Meridian</span>
        </Link>
        <nav className="landing-nav" style={{ display: "flex", alignItems: "center", gap: "40px", fontSize: "17px", fontWeight: "500", letterSpacing: "-0.01em", flexWrap: "wrap", justifyContent: "center" }}>
          <Link href="/">Home</Link>
          <Link href="/trade">Trade</Link>
          <Link href="/earn">Earn</Link>
          <Link href="/fix">Fix</Link>
          <Link href="/stats">Stats</Link>
        </nav>
        <Link href="/trade" style={{ background: "#fff", color: "#0e100f", borderRadius: "999px", padding: "16px 32px", fontSize: "17px", fontWeight: "600", letterSpacing: "-0.01em", whiteSpace: "nowrap" }} className="hover-light">Connect Wallet</Link>
      </header>

      <div style={{ position: "relative", zIndex: "4", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "92px 20px 0" }}>
        <h1 style={{ margin: "0", fontSize: "clamp(28px,5.8vw,84px)", lineHeight: "1.06", fontWeight: "600", letterSpacing: "-0.045em", display: "flex", flexDirection: "column", alignItems: "center", whiteSpace: "nowrap" }}>
          <span style={{ display: "flex", justifyContent: "center", columnGap: "0.24em" }}>
            <IntroWord text="Funding" />
            <IntroWord text="Rates," />
          </span>
          <span style={{ display: "flex", justifyContent: "center", columnGap: "0.24em" }}>
            <IntroWord text="Every" />
            <IntroWord text="Block." />
          </span>
        </h1>
        <p data-fade="1" style={{ margin: "34px 0 0", fontSize: "clamp(16px,1.3vw,19px)", color: "#e8e8e8", letterSpacing: "-0.01em" }}>Trade MON-PERP with funding every block, earn the basis, or fix your funding rate. All in AUSD, on Monad.</p>
        <div data-fade="1" style={{ display: "flex", gap: "20px", marginTop: "48px", flexWrap: "wrap", justifyContent: "center" }}>
          <Link href="/trade" style={{ background: "#a08ffb", color: "#0e100f", borderRadius: "999px", width: "186px", height: "68px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px", fontWeight: "600" }} className="hover-primary">Launch App</Link>
          <a href="https://github.com/SamyaDeb/meridian" target="_blank" rel="noreferrer" style={{ background: "#180b2b", color: "#fff", border: "1px solid #261146", borderRadius: "999px", width: "182px", height: "68px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px", fontWeight: "600" }} className="hover-dark">View on GitHub</a>
        </div>
      </div>

      <div style={{ position: "relative", zIndex: "6", maxWidth: "1440px", margin: "104px auto 0", height: "700px" }}>
        <div style={{ position: "absolute", left: "50%", width: "100vw", transform: "translateX(-50%)", top: "-60px", height: "760px", background: "url(/landing/hero-bg.jpg) center/100% 100% no-repeat", WebkitMaskImage: "linear-gradient(180deg,transparent 0%,#000 18%)", maskImage: "linear-gradient(180deg,transparent 0%,#000 18%)", pointerEvents: "none" }}></div>
        <>
          <div data-side="l" style={{ position: "absolute", left: "4.5%", top: "0", animation: "floatY 6s ease-in-out infinite" }}>
            <div data-card="1" style={{ display: "flex", alignItems: "center", gap: "12px", background: "#2b2b2b", border: "1px solid #3a3a3a", borderRadius: "999px", padding: "10px 20px 10px 12px" }}>
              <div style={{ width: "26px", height: "26px", borderRadius: "50%", background: "#836ef9", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#0e100f" strokeWidth="1.8"><line x1="7" y1="12" x2="7" y2="2" /><polyline points="3,6 7,2 11,6" /></svg></div>
              <span style={{ fontSize: "17px", fontWeight: "500" }}>Every 300 ms</span>
            </div>
          </div>
          <div data-side="l" style={{ position: "absolute", left: "4%", top: "72px", animation: "floatY 7s ease-in-out infinite 0.8s" }}>
            <div data-card="1" style={{ transform: "rotate(-5deg)", background: "#2b2b2b", border: "1px solid #3a3a3a", borderRadius: "22px", padding: "26px 26px 22px", width: "190px", boxShadow: "0 20px 40px rgba(0,0,0,0.35)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "17px", color: "#ececec" }}>Funding <span style={{ width: "14px", height: "14px", border: "1.5px solid #836ef9", borderRadius: "50%", color: "#836ef9", fontSize: "9px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>$</span></div>
              <div style={{ fontSize: "30px", fontWeight: "700", letterSpacing: "-0.04em", marginTop: "10px" }}>Per block</div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "16px", fontSize: "17px" }}>
                <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "linear-gradient(135deg,#836ef9,#b9b0ea)", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="#0e100f" strokeWidth="2"><line x1="7" y1="12" x2="7" y2="2" /><polyline points="3,6 7,2 11,6" /></svg></div>
                O(1) index
              </div>
            </div>
          </div>
          <div data-side="r" style={{ position: "absolute", right: "4.5%", top: "0", animation: "floatY 6.5s ease-in-out infinite 0.4s" }}>
            <div data-card="1" style={{ background: "#2b2b2b", border: "1px solid #3a3a3a", borderRadius: "22px", padding: "28px 28px 26px", width: "200px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "17px", color: "#ececec" }}>Funding <span style={{ width: "14px", height: "14px", border: "1.5px solid #836ef9", borderRadius: "50%", color: "#836ef9", fontSize: "9px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>$</span></div>
              <div style={{ fontSize: "32px", fontWeight: "700", letterSpacing: "-0.04em", marginTop: "12px" }}>5x max</div>
            </div>
          </div>
          <div data-side="r" style={{ position: "absolute", right: "11.5%", top: "170px", animation: "floatY 7.5s ease-in-out infinite 1.2s" }}>
            <div data-card="1" style={{ display: "flex", alignItems: "center", gap: "10px", background: "#2b2b2b", border: "1px solid #3a3a3a", borderRadius: "999px", padding: "8px 18px 8px 10px" }}>
              <div style={{ display: "flex" }}>
                <div style={{ width: "32px", height: "32px", borderRadius: "50%", background: "#a79de1", border: "2px solid #2b2b2b" }}></div>
                <div style={{ width: "32px", height: "32px", borderRadius: "50%", background: "#aca2e5", border: "2px solid #2b2b2b", marginLeft: "-6px" }}></div>
                <div style={{ width: "32px", height: "32px", borderRadius: "50%", background: "#bcb3f0", border: "2px solid #2b2b2b", marginLeft: "-6px" }}></div>
              </div>
              <span style={{ color: "#836ef9", fontSize: "16px" }}>♥</span>
              <span style={{ fontSize: "19px", fontWeight: "600", letterSpacing: "-0.02em" }}>AUSD</span>
            </div>
          </div>
          <div data-side="r" data-card="1" style={{ position: "absolute", right: "7.2%", top: "205px", width: "50px", height: "50px", borderRadius: "50%", background: "linear-gradient(135deg,#836ef9,#b9b0ea)", display: "flex", alignItems: "center", justifyContent: "center", animation: "floatY 5.5s ease-in-out infinite 0.2s" }}>
            <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="#0e100f" strokeWidth="1.6"><line x1="7" y1="13" x2="7" y2="2" /><polyline points="3.5,5.5 7,2 10.5,5.5" /></svg>
          </div>
        </>

        <div data-phone="1" style={{ position: "absolute", left: "50%", top: "0", transform: "translateX(-50%)", width: "min(496px,86vw)", height: "780px", borderRadius: "78px", background: "#111", border: "3px solid #3b3b3b", padding: "16px", boxShadow: "0 0 0 2px #1a1a1a inset" }}>
          <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: "62px", overflow: "hidden", background: "#fff", color: "#0e100f" }}>
            <div style={{ background: "linear-gradient(180deg,#bcb4ea 0%,#d3ceee 60%,#dedaf2 100%)", padding: "18px 34px 0", height: "370px", borderRadius: "0 0 26px 26px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "19px", fontWeight: "600" }}>
                <span>19:02</span>
                <div style={{ width: "124px", height: "34px", borderRadius: "20px", background: "#0e100f" }}></div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: "2px" }}><div style={{ width: "3px", height: "5px", background: "#111" }}></div><div style={{ width: "3px", height: "7px", background: "#111" }}></div><div style={{ width: "3px", height: "9px", background: "#111" }}></div><div style={{ width: "3px", height: "11px", background: "#111" }}></div></div>
                  <div style={{ width: "26px", height: "12px", borderRadius: "3px", background: "#111" }}></div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "36px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ width: "36px", height: "36px", borderRadius: "9px", background: "linear-gradient(135deg,#836ef9,#b9b0ea)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Image src="/landing/logo.png" alt="" width={28} height={28} style={{ display: "block" }} priority />
                  </div>
                  <span style={{ fontSize: "24px", fontWeight: "600", letterSpacing: "-0.03em" }}>Meridian</span>
                </div>
                <div style={{ display: "flex", gap: "18px", alignItems: "center" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="17" y1="17" x2="22" y2="22" /></svg>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2"><path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z" /><path d="M10 21h4" /></svg>
                </div>
              </div>
              <div style={{ textAlign: "center", marginTop: "40px" }}>
                <div style={{ fontSize: "17px", fontWeight: "600" }}>Account Equity</div>
                <div style={{ fontSize: "52px", fontWeight: "700", letterSpacing: "-0.03em", marginTop: "18px", lineHeight: "1" }}>$36,020.00</div>
                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "16px", marginTop: "14px", fontSize: "17px" }}>
                  <span style={{ fontWeight: "600" }}>$32,454.786</span><span style={{ fontWeight: "500" }}>+2.5% <span style={{ color: "#fff" }}>↑</span></span>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "16px", padding: "0 42px", marginTop: "-30px" }}>
              <div style={{ flex: "1", height: "60px", borderRadius: "14px", background: "#0e021f", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", fontSize: "18px", fontWeight: "600" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8"><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /><line x1="12" y1="3" x2="12" y2="14" /><polyline points="8,10 12,14 16,10" /></svg>Deposit
              </div>
              <div style={{ flex: "1", height: "60px", borderRadius: "14px", background: "#0e021f", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", fontSize: "18px", fontWeight: "600" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8"><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /><line x1="12" y1="14" x2="12" y2="3" /><polyline points="8,7 12,3 16,7" /></svg>Withdraw
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 34px", marginTop: "40px" }}>
              <span style={{ fontSize: "22px", fontWeight: "700", letterSpacing: "-0.02em" }}>Markets</span>
              <span style={{ fontSize: "17px", fontWeight: "600" }}>See All</span>
            </div>
            <div style={{ display: "flex", gap: "18px", padding: "0 34px", marginTop: "22px" }}>
              <div style={{ flex: "0 0 186px", height: "170px", borderRadius: "18px", background: "linear-gradient(180deg,#fbe9d4,#fff6ec)", padding: "22px 18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "#f5a04a" }}></div>
                  <div><div style={{ fontSize: "17px", fontWeight: "600" }}>MON</div><div style={{ fontSize: "13px", color: "#9a9a9a", marginTop: "2px" }}>MON-PERP</div></div>
                </div>
              </div>
              <div style={{ flex: "0 0 186px", height: "170px", borderRadius: "18px", background: "linear-gradient(180deg,#e0ddf1,#f2f1fa)", padding: "22px 18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "#836ef9" }}></div>
                  <div><div style={{ fontSize: "17px", fontWeight: "600" }}>VLT</div><div style={{ fontSize: "13px", color: "#9a9a9a", marginTop: "2px" }}>Basis vault</div></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div style={{ position: "absolute", left: "50%", width: "100vw", transform: "translateX(-50%)", bottom: "0", height: "200px", background: "linear-gradient(180deg,rgba(255,255,255,0) 0%,#ffffff 90%)" }}></div>
      </div>
    </section>
  );
}
