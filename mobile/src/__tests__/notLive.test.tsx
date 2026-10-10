// N8 D4.3: APP_ENV=production with today's deployments (no deployments/143.json until N9) ⇒ the calm "Meridian isn't
// live on mainnet yet" over the app: no crash, never a testnet fallback. Staging / development never show it.
jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));

import meridian10143 from "../../../deployments/10143.json";
import perplJson from "../../../deployments/perpl.json";
import { render, screen } from "@testing-library/react-native";
import { buildAppConfig } from "../config/appConfig";
import { NotLiveGate, waitingForMainnet } from "../features/shell/NotLive";
import { createLive, type Live } from "../live/live";
import { LiveProvider } from "../live/LiveProvider";
import { Text } from "../ui";
import { fakeLive } from "./fakeLive";
import { fs, path, SRC_DIR } from "./node";

// exactly what src/config/index.ts passes today
const today = { rpcUrl: "https://rpc.example.invalid", wsUrl: undefined, meridianDeployments: { 10143: meridian10143 }, perplJson };

function withConfig(appEnv: string): Live {
  const { live } = fakeLive();
  return { ...live, config: buildAppConfig({ ...today, appEnv }) };
}

it("production with the current deployments: waiting for mainnet, chain 143, production identity, no testnet anything", () => {
  const c = buildAppConfig({ ...today, appEnv: "production" });
  expect(waitingForMainnet(c)).toBe(true);
  expect(c.chainId).toBe(143);
  expect(c.chain.id).toBe(143);
  expect(c.rpId).toBe("meridianfi.vercel.app");
  expect(c.meridian.status).not.toBe("deployed");
  expect(c.rpc?.isPublic).toBe(false);
  expect(c.perplWsUrl).toBe("wss://app.perpl.xyz");
  expect(c.webUrl).toBeUndefined();
  expect(JSON.stringify({ rpId: c.rpId, ws: c.perplWsUrl, web: c.webUrl, rpc: c.rpc })).not.toMatch(/testnet|10143/);
  // and the app's config wiring still has no 143 record (this test flips when N9 adds it)
  expect(fs.readFileSync(path.join(SRC_DIR, "config", "index.ts"), "utf8")).toMatch(/meridianDeployments: \{ 10143: meridian10143 \}/);
});

it("the live layer builds on that config without a crash (no Meridian reader, nothing started)", () => {
  const live = createLive(buildAppConfig({ ...today, appEnv: "production" }), { client: { multicall: async () => [] } as never });
  expect(live.meridian).toBeUndefined();
  expect(live.config.chainId).toBe(143);
});

it("staging and development are never 'waiting for mainnet'", () => {
  for (const env of ["staging", "development"]) expect(waitingForMainnet(buildAppConfig({ ...today, appEnv: env }))).toBe(false);
});

it("renders the calm state over the app on production; the app alone elsewhere", async () => {
  const first = await render(
    <LiveProvider live={withConfig("production")}>
      <NotLiveGate>
        <Text testID="app">app</Text>
      </NotLiveGate>
    </LiveProvider>,
  );
  expect(screen.getByTestId("not-live")).toHaveTextContent(/Meridian isn't live on mainnet yet/);
  expect(screen.getByTestId("not-live")).toHaveTextContent(/No trade or deposit can be sent until then/);
  // LiveProvider keeps its first Live for the app's lifetime: a fresh tree for the other env
  first.unmount();
  await render(
    <LiveProvider live={withConfig("staging")}>
      <NotLiveGate>
        <Text testID="app">app</Text>
      </NotLiveGate>
    </LiveProvider>,
  );
  expect(screen.queryByTestId("not-live")).toBeNull();
  expect(screen.getByTestId("app")).toBeTruthy();
});
