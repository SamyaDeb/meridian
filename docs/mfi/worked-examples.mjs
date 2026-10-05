// Verifies the worked examples in docs/MFI.md §8. bigint only; run: node docs/mfi/worked-examples.mjs
// Inputs are SYNTHETIC (illustrative numbers, not recorded Perpl or Meridian data).
const WAD = 10n ** 18n;
const YEAR = 31_536_000n; // 365 d, SECONDS_PER_YEAR in PulseConstants
const assert = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); };
const tdiv = (a, b) => a / b; // bigint division truncates toward zero = "rounds neutral (toward zero)" (§4.4)

// §3.1 Meridian: per-second WAD rate -> APR WAD
const meridianApr = (ratePerSecWad) => ratePerSecWad * YEAR;
// §3.2 Perpl: micros per funding interval -> APR WAD
const perplApr = (rateMicros, intervalSec) => tdiv(rateMicros * 10n ** 12n * YEAR, intervalSec);
// §4.1 OI notional (one side) in AUSD WAD
const meridianOi = (oiBaseWad, markWad) => (oiBaseWad * markWad) / WAD; // floor; weights only
const perplOi = (oiScaled, sizeDec, markScaled, priceDec) => (oiScaled * 10n ** (18n - sizeDec) * markScaled * 10n ** (18n - priceDec)) / WAD;
// §4.2 index
function mfi(venues) {
  const live = venues.filter((v) => v.included);
  if (live.length === 0) return { aprWad: null, weighting: "none" };
  const tot = live.reduce((s, v) => s + v.oiWad, 0n);
  if (tot === 0n) return { aprWad: tdiv(live.reduce((s, v) => s + v.aprWad, 0n), BigInt(live.length)), weighting: "equal" };
  return { aprWad: tdiv(live.reduce((s, v) => s + v.oiWad * v.aprWad, 0n), tot), weighting: "oi", weightsBps: live.map((v) => (v.oiWad * 10_000n) / tot) };
}
const show = (x) => `${x} (${(Number(x) / 1e16).toFixed(6)}%)`;
const out = [];

// Example A: both venues live
const aM = meridianApr(3_472_222_222n);
assert(aM === 109_499_999_992_992_000n, "A meridian apr");
const aP = perplApr(12n, 3600n);
assert(aP === 105_120_000_000_000_000n, "A perpl apr");
const oiM = meridianOi(3_150_000n * WAD, 29_579n * 10n ** 12n); // 3.15M MON at 0.029579
assert(oiM === 93_173_850_000_000_000_000_000n, "A meridian oi");
const oiP = perplOi(40_000_000n * 10n ** 2n, 2n, 296_000n, 7n); // 40M MON (size_decimals 2) at 0.0296000 (price_decimals 7)
assert(oiP === 1_184_000_000_000_000_000_000_000n, "A perpl oi");
const A = mfi([{ included: true, aprWad: aM, oiWad: oiM }, { included: true, aprWad: aP, oiWad: oiP }]);
assert(A.aprWad === 105_439_534_777_780_673n, `A mfi ${A.aprWad}`);
assert(A.weightsBps[0] === 729n && A.weightsBps[1] === 9270n, "A weights");
out.push(`A meridianApr=${show(aM)} perplApr=${show(aP)} oiM=${oiM} oiP=${oiP} weightsBps=${A.weightsBps} MFI=${show(A.aprWad)}`);

// Example B: Perpl unavailable -> Meridian only
const B = mfi([{ included: true, aprWad: aM, oiWad: oiM }, { included: false, aprWad: 0n, oiWad: 0n }]);
assert(B.aprWad === aM, "B equals meridian");
out.push(`B MFI=${show(B.aprWad)} venues=[meridian]`);

// Example C: negative Perpl rate with an 8,571-block interval (the R27 figure), rounding toward zero
const cP = perplApr(-7n, 2571n); // 8,571 blocks x 0.3 s = 2,571.3 s; Perpl reports funding_interval_sec, use it as given
assert(cP === -85_862_310_385_064_177n, `C perpl apr ${cP}`);
// toward zero: |exact| = 7e12*31536000/2571 ≈ 85862310385064177.2
assert(-cP * 2571n <= 7n * 10n ** 12n * YEAR && (-cP + 1n) * 2571n > 7n * 10n ** 12n * YEAR, "C truncation toward zero");
const C = mfi([{ included: true, aprWad: aM, oiWad: oiM }, { included: true, aprWad: cP, oiWad: oiP }]);
assert(C.aprWad === -71_610_015_286_148_356n, `C mfi ${C.aprWad}`);
out.push(`C perplApr=${show(cP)} MFI=${show(C.aprWad)}`);

// Example D: zero OI on both -> equal weights
const D = mfi([{ included: true, aprWad: aM, oiWad: 0n }, { included: true, aprWad: aP, oiWad: 0n }]);
assert(D.aprWad === 107_309_999_996_496_000n && D.weighting === "equal", `D ${D.aprWad}`);
out.push(`D MFI=${show(D.aprWad)} weighting=equal`);

// Example E: nothing fresh -> null
assert(mfi([{ included: false }, { included: false }]).aprWad === null, "E null");
out.push("E MFI=null stale=true");

console.log(out.join("\n"));
console.log("all worked examples verified");
