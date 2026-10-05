import { describe, expect, it } from "vitest";
import { monad, monadTestnet } from "viem/chains";
import { buildPrivyConfig, privyEnabled } from "./privy";

describe("privy config", () => {
  it("is disabled without NEXT_PUBLIC_PRIVY_APP_ID (this env has none)", () => {
    expect(privyEnabled).toBe(false);
  });
  it("email login, embedded wallet for users without one, Monad chains", () => {
    const c = buildPrivyConfig(10143);
    expect(c.loginMethods).toEqual(["email"]);
    expect(c.embeddedWallets?.ethereum?.createOnLogin).toBe("users-without-wallets");
    expect(c.defaultChain?.id).toBe(10143);
    expect(c.supportedChains?.map((x) => x.id)).toEqual([monadTestnet.id, monad.id]);
    expect(buildPrivyConfig(143).defaultChain?.id).toBe(143);
  });
});
