import { describe, expect, it } from "vitest";
import { monad, monadTestnet } from "viem/chains";
import { buildPrivyConfig, privyEnabled } from "./privy";

describe("privy config", () => {
  it("is disabled without NEXT_PUBLIC_PRIVY_APP_ID (this env has none)", () => {
    expect(privyEnabled).toBe(false);
  });
  it("email / passkey / Google / external wallet login, embedded wallet for users without one, Monad chains", () => {
    const c = buildPrivyConfig(10143);
    expect(c.loginMethods).toEqual(["email", "passkey", "google", "wallet"]);
    expect(c.embeddedWallets?.ethereum?.createOnLogin).toBe("users-without-wallets");
    expect(c.defaultChain?.id).toBe(10143);
    expect(c.supportedChains?.map((x) => x.id)).toEqual([monadTestnet.id, monad.id]);
    expect(buildPrivyConfig(143).defaultChain?.id).toBe(143);
  });
});

describe("wagmi connectors (K1.1)", () => {
  it("with Privy the bare injected connector is dropped; the anvil dev connector stays", async () => {
    const { connectorsFor } = await import("./wagmi");
    const dev = "0x00000000000000000000000000000000000000aa" as const;
    expect(connectorsFor(false, undefined)).toHaveLength(1);
    expect(connectorsFor(false, dev)).toHaveLength(2);
    expect(connectorsFor(true, undefined)).toHaveLength(0);
    expect(connectorsFor(true, dev)).toHaveLength(1);
  });
});
