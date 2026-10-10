// N7 in-app alerts: liquidation < 5 % fires once and re-arms above 6 %; a funding flip fires on a sign change only;
// prefs default to off (progressive) and survive garbage.
import { decodePrefs, freshMemory, fundingAlerts, liqAlerts } from "../../features/alerts/rules";

it("liquidation: fires once below 5 %, quiet while it stays there, re-arms above 6 %, resets when the position closes", () => {
  const m = freshMemory();
  expect(liqAlerts(m, { perpl: 900n })).toEqual([]);
  const a = liqAlerts(m, { perpl: 480n });
  expect(a).toEqual([{ key: "liq-perpl", text: "Your Perpl position is 4.8% from liquidation. Reduce or close it to stay clear." }]);
  expect(liqAlerts(m, { perpl: 300n })).toEqual([]);
  expect(liqAlerts(m, { perpl: 550n })).toEqual([]); // between 5 and 6 %: still armed off
  expect(liqAlerts(m, { perpl: 450n })).toEqual([]);
  expect(liqAlerts(m, { perpl: 650n })).toEqual([]);
  expect(liqAlerts(m, { perpl: 490n })).toHaveLength(1);
  expect(liqAlerts(m, { perpl: undefined })).toEqual([]);
  expect(liqAlerts(m, { perpl: 100n, meridian: 0n }).map((x) => x.key)).toEqual(["liq-meridian", "liq-perpl"]);
});

it("funding: the first reading only remembers the side; a sign change alerts in plain words; zero is no flip", () => {
  const m = freshMemory();
  expect(fundingAlerts(m, { perpl: 5n, meridian: -2n })).toEqual([]);
  expect(fundingAlerts(m, { perpl: 7n, meridian: -1n })).toEqual([]);
  expect(fundingAlerts(m, { perpl: -1n })).toEqual([{ key: "funding-perpl", text: "Funding flipped on Perpl: shorts now pay longs." }]);
  expect(fundingAlerts(m, { meridian: 0n })).toEqual([]);
  expect(fundingAlerts(m, { meridian: 3n })).toEqual([{ key: "funding-meridian", text: "Funding flipped on Meridian: longs now pay shorts." }]);
  expect(fundingAlerts(m, { meridian: undefined, perpl: undefined })).toEqual([]);
});

it("prefs: off unless stored on; garbage ⇒ off", () => {
  expect(decodePrefs(null)).toEqual({ liq: false, funding: false });
  expect(decodePrefs('{"liq":true}')).toEqual({ liq: true, funding: false });
  expect(decodePrefs('{"liq":"yes","funding":1}')).toEqual({ liq: false, funding: false });
  expect(decodePrefs("{oops")).toEqual({ liq: false, funding: false });
});
