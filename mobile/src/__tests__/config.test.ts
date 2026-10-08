import meridian10143 from "../../../deployments/10143.json";
import perplJson from "../../../deployments/perpl.json";
import { buildAppConfig, parseAppEnv } from "../config/appConfig";

const base = { rpcUrl: undefined, wsUrl: undefined, meridianDeployments: { 10143: meridian10143 }, perplJson };

describe("buildAppConfig", () => {
  it("development: testnet, staging identity, viem's public RPC with the public flag", () => {
    const c = buildAppConfig({ ...base, appEnv: "development" });
    expect(c.chainId).toBe(10143);
    expect(c.chain.id).toBe(10143);
    expect(c.rpId).toBe("meridian-testnet.vercel.app");
    expect(c.androidPackage).toBe("xyz.meridianfi.app.staging");
    expect(c.rpc?.isPublic).toBe(true);
    expect(c.meridian.status).toBe("deployed");
    expect(c.perpl.status).toBe("deployed");
    expect(c.perplWsUrl).toBe("wss://testnet.perpl.xyz");
    expect(c.live).toBe(true);
  });

  it("missing APP_ENV defaults to development", () => {
    expect(buildAppConfig({ ...base, appEnv: undefined }).env).toBe("development");
  });

  it("a configured RPC wins and is not marked public", () => {
    const c = buildAppConfig({ ...base, appEnv: "development", rpcUrl: " https://rpc.example.invalid/k ", wsUrl: "wss://rpc.example.invalid/k" });
    expect(c.rpc).toEqual({ http: "https://rpc.example.invalid/k", ws: "wss://rpc.example.invalid/k", isPublic: false });
  });

  it("staging without an RPC: no public fallback, not live, says why", () => {
    const c = buildAppConfig({ ...base, appEnv: "staging" });
    expect(c.chainId).toBe(10143);
    expect(c.rpc).toBeUndefined();
    expect(c.live).toBe(false);
    expect(c.notLiveReason).toMatch(/No RPC/);
  });

  it("production: chain 143, Meridian not live yet (no 143.json) without crashing; Perpl mainnet still configured", () => {
    const c = buildAppConfig({ ...base, appEnv: "production", rpcUrl: "https://rpc.example.invalid" });
    expect(c.chainId).toBe(143);
    expect(c.rpId).toBe("meridianfi.vercel.app");
    expect(c.androidPackage).toBe("xyz.meridianfi.app");
    expect(c.meridian.status).toBe("not-deployed");
    expect(c.perpl.status).toBe("deployed");
    expect(c.perplWsUrl).toBe("wss://app.perpl.xyz");
    expect(c.live).toBe(false);
    expect(c.notLiveReason).toMatch(/isn't live on Monad mainnet yet/);
  });

  it("rejects non-TLS RPC URLs and unknown envs", () => {
    expect(() => buildAppConfig({ ...base, appEnv: "development", rpcUrl: "http://rpc.example.invalid" })).toThrow(/https/);
    expect(() => buildAppConfig({ ...base, appEnv: "development", rpcUrl: "https://a.invalid", wsUrl: "ws://a.invalid" })).toThrow(/wss/);
    expect(() => parseAppEnv("prod")).toThrow(/APP_ENV/);
  });
});
