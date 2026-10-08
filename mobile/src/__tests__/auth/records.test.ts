import { checkRecord, CredentialStore } from "../../auth/credentialStore";
import { KNOWN_RP_IDS, rpIdProblem } from "../../auth/rpGuard";
import { buildAppConfig } from "../../config/appConfig";
import meridian10143 from "../../../../deployments/10143.json";
import perplJson from "../../../../deployments/perpl.json";
import { memoryKv } from "./authFixtures";

const ok = { credentialId: "AbCdEfGhIjKlMnOpQrStUv_-", createdAt: 1_700_000_000_000, addressHint: "0x50b240678777451befd67b7e8c3b4366482ba8f9" };

describe("credential record", () => {
  it("accepts exactly the four fields and checksums the hint", () => {
    expect(checkRecord({ ...ok, transports: ["internal", "hybrid"] })).toEqual({ ...ok, transports: ["internal", "hybrid"], addressHint: "0x50B240678777451BEfd67B7e8c3b4366482ba8F9" });
  });
  it.each([
    [{ ...ok, prf: "x" }],
    [{ ...ok, credentialId: "has space here and more" }],
    [{ ...ok, credentialId: "short" }],
    [{ ...ok, addressHint: "0x1234" }],
    [{ ...ok, createdAt: -1 }],
    [{ ...ok, transports: ["INTERNAL"] }],
    [null],
  ])("refuses %j", (r) => {
    expect(() => checkRecord(r)).toThrow();
  });
  it("an unreadable stored record is forgotten, not trusted", async () => {
    const kv = memoryKv();
    const store = new CredentialStore(kv, "meridian-testnet.vercel.app");
    await kv.set(store.key, "{not json");
    expect(await store.read()).toBeUndefined();
    expect(kv.data.size).toBe(0);
  });
});

describe("rpId guard", () => {
  it("every APP_ENV's configured rpId is the known one", () => {
    for (const env of ["development", "staging", "production"] as const) {
      const cfg = buildAppConfig({ appEnv: env, rpcUrl: undefined, wsUrl: undefined, meridianDeployments: { 10143: meridian10143 }, perplJson });
      expect(cfg.rpId).toBe(KNOWN_RP_IDS[env]);
      expect(rpIdProblem(cfg)).toBeUndefined();
    }
  });
  it("refuses a mismatch (e.g. a staging rpId in a production build)", () => {
    expect(rpIdProblem({ env: "production", rpId: "meridian-testnet.vercel.app" })).toMatch(/wrong passkey domain/);
    expect(rpIdProblem({ env: "development", rpId: "meridianfi.vercel.app" })).toMatch(/wrong passkey domain/);
  });
});
