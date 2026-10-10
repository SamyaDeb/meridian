import { describe, expect, it, vi } from "vitest";
vi.mock("./WriteGate", () => ({ useWriteGate: () => ({}) }));
vi.mock("@/lib/wagmi", () => ({ READ_CHAIN_ID: 10143 }));
import { connectButtons } from "./Wallet";

const c = (id: string, name: string, type = "injected") => ({ uid: `${id}-uid`, id, name, type });

describe("connect buttons", () => {
  it("Brave: the announced wallet replaces the generic injected one (one button, not two)", () => {
    const b = connectButtons([c("injected", "Injected"), c("com.brave.wallet", "Brave Wallet")]);
    expect(b.map((x) => [x.connector.id, x.label])).toEqual([["com.brave.wallet", "Connect wallet"]]);
  });
  it("no announced wallet: the generic one stays", () => {
    expect(connectButtons([c("injected", "Injected")]).map((x) => x.label)).toEqual(["Connect wallet"]);
  });
  it("several announced wallets: each button names its wallet", () => {
    const b = connectButtons([c("injected", "Injected"), c("io.metamask", "MetaMask"), c("com.brave.wallet", "Brave Wallet")]);
    expect(b.map((x) => x.label)).toEqual(["Connect MetaMask", "Connect Brave Wallet"]);
  });
  it("the anvil dev account stays", () => {
    expect(connectButtons([c("injected", "Injected"), c("mock", "Mock", "mock")]).map((x) => x.label)).toEqual(["Connect wallet", "Dev account"]);
  });
});
