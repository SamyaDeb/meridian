import { mockTokenAbi } from "@meridian/core/meridian";
import { decodeFunctionData } from "viem";
import { fakeLive } from "../fakeLive";
import { mintableTestAusd, mintTestAusdTx } from "../../wallet/testFunds";

describe("test funds", () => {
  it("testnet: Meridian's AUSD mock, mint(to, 10,000 × 10^decimals)", () => {
    const { config } = fakeLive().live;
    const token = mintableTestAusd(config);
    expect(config.meridian.status === "deployed" && token).toBe(config.meridian.status === "deployed" ? config.meridian.deployment.contracts.AUSD : false);
    const to = "0x50B240678777451BEfd67B7e8c3b4366482ba8F9";
    const tx = mintTestAusdTx(token!, to, 6);
    expect(tx.to).toBe(token);
    expect(decodeFunctionData({ abi: mockTokenAbi, data: tx.data! })).toEqual({ functionName: "mint", args: [to, 10_000_000_000n] });
  });

  it("never on mainnet, never when AUSD isn't a mock", () => {
    const { config } = fakeLive().live;
    expect(mintableTestAusd({ ...config, chainId: 143 })).toBeUndefined();
    if (config.meridian.status !== "deployed") throw new Error("fixture");
    const real = { ...config, meridian: { ...config.meridian, deployment: { ...config.meridian.deployment, mockContracts: [] } } };
    expect(mintableTestAusd(real)).toBeUndefined();
  });
});
