import { meridianEffectiveAprWad, spreadAprWad } from "@meridian/core/route";
import { act, render, screen } from "@testing-library/react-native";
import { SpreadPanel, spreadSentence } from "../features/welcome/SpreadPanel";
import { LiveProvider } from "../live/LiveProvider";
import { formatValue } from "../ui";
import { fakeLive } from "./fakeLive";

const WAD = 10n ** 18n;

it("shows dashes while either venue is unknown", async () => {
  const { live } = fakeLive();
  await render(
    <LiveProvider live={live}>
      <SpreadPanel />
    </LiveProvider>,
  );
  expect(screen.getByTestId("spread")).toHaveTextContent("—");
  expect(screen.getByTestId("meridian-apr")).toHaveTextContent("—");
  expect(screen.getByTestId("perpl-apr")).toHaveTextContent("—");
  expect(screen.getByText("Waiting for both venues.")).toBeTruthy();
});

it("shows real values computed through core once both venues report", async () => {
  const { live, blocks, meridian, perpl, timer } = fakeLive();
  await render(
    <LiveProvider live={live}>
      <SpreadPanel />
    </LiveProvider>,
  );
  // Meridian: rate 1e-9 / contract-second, blockTimeMs 400; the chain runs 10 blocks in 4 s ⇒ nominal speed
  const rate = 10n ** 9n;
  await act(async () => {
    blocks.observe(1_000n);
    timer.tick(4_000);
    blocks.observe(1_010n);
    meridian.store.update({ rateWad: rate, paramBlockTimeMs: 400n });
    perpl.store.update({ aprNowWad: WAD / 50n }); // 2 % a year
  });
  const m = meridianEffectiveAprWad(rate, 400n, { blocks: 10n, elapsedMs: 4_000n });
  expect(m).toBe(rate * 31_536_000n);
  expect(screen.getByTestId("meridian-apr")).toHaveTextContent(formatValue(m, "apr", { signed: true }));
  expect(screen.getByTestId("perpl-apr")).toHaveTextContent("+2.00%");
  const spread = spreadAprWad(m, WAD / 50n);
  expect(screen.getByTestId("spread")).toHaveTextContent(formatValue(spread, "apr", { signed: true }));
  expect(screen.getByText(spreadSentence(spread))).toBeTruthy();
});

it("plain-language direction of the gap", async () => {
  expect(spreadSentence(WAD / 10n)).toBe("Longs pay 10.00% a year more on Meridian than on Perpl.");
  expect(spreadSentence(-WAD / 10n)).toBe("Longs pay 10.00% a year more on Perpl than on Meridian.");
  expect(spreadSentence(0n)).toBe("Both venues charge the same funding right now.");
});
