import { describe, expect, it } from "vitest";
import { createConfig, custom } from "wagmi";
import { disconnect, getConnectorClient, switchChain } from "wagmi/actions";
import { foundry, monadTestnet } from "viem/chains";
import { recoverTransactionAddress, numberToHex } from "viem";
import { connectPasskey, PASSKEY_CONNECTOR_TYPE } from "./connector";
import { PasskeyWallet } from "./wallet";
import { fakeAuthenticator, memoryKV, PRF_SEQ, SEQ_ADDRESS } from "./testing";

// Reads go to this fake node; the connector must never send it an unsigned eth_sendTransaction.
function fakeNode() {
  const seen: string[] = [];
  const request = async ({ method }: { method: string }) => {
    seen.push(method);
    if (method === "eth_chainId") return numberToHex(monadTestnet.id);
    if (method === "eth_blockNumber") return "0x10";
    throw new Error(`unexpected ${method}`);
  };
  return { seen, transport: custom({ request }) };
}

async function setup() {
  const node = fakeNode();
  const config = createConfig({ chains: [monadTestnet, foundry], transports: { [monadTestnet.id]: node.transport, [foundry.id]: node.transport }, connectors: [] });
  const wallet = new PasskeyWallet({ rpId: "meridian-testnet.vercel.app", kv: memoryKV(), webAuthnClient: fakeAuthenticator([PRF_SEQ]) });
  await wallet.create("x");
  return { config, wallet, node };
}

describe("passkey wagmi connector", () => {
  it("connects the unlocked wallet on the read chain; the client signs locally", async () => {
    const { config, wallet, node } = await setup();
    const r = await connectPasskey(config, wallet, monadTestnet.id);
    expect(r.accounts).toEqual([SEQ_ADDRESS]);
    expect(config.state.status).toBe("connected");
    const conn = config.state.connections.get(config.state.current!)!;
    expect(conn.connector.type).toBe(PASSKEY_CONNECTOR_TYPE);
    expect(conn.chainId).toBe(monadTestnet.id);
    const client = await getConnectorClient(config);
    expect(client.account.address).toBe(SEQ_ADDRESS);
    expect(client.account.type).toBe("local");
    const signed = await client.account.signTransaction!({ chainId: monadTestnet.id, to: SEQ_ADDRESS, value: 1n, nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "eip1559" });
    expect(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toBe(SEQ_ADDRESS);
    expect(node.seen).not.toContain("eth_sendTransaction");
  });

  it("refuses to connect while locked", async () => {
    const { config, wallet } = await setup();
    wallet.lock();
    await expect(connectPasskey(config, wallet, monadTestnet.id)).rejects.toThrow(/locked/);
    expect(config.state.status).toBe("disconnected");
  });

  it("an idle / manual lock disconnects wagmi; disconnect locks the wallet", async () => {
    const { config, wallet } = await setup();
    await connectPasskey(config, wallet, monadTestnet.id);
    wallet.lock("idle");
    expect(config.state.status).toBe("disconnected");
    expect(await wallet.unlock()).toBe(SEQ_ADDRESS);
    await connectPasskey(config, wallet, monadTestnet.id);
    await disconnect(config);
    expect(wallet.getState().status).toBe("locked");
  });

  it("switches between configured chains only", async () => {
    const { config, wallet } = await setup();
    await connectPasskey(config, wallet, monadTestnet.id);
    await switchChain(config, { chainId: foundry.id });
    expect(config.state.connections.get(config.state.current!)!.chainId).toBe(foundry.id);
    await expect(switchChain(config, { chainId: 143 as never })).rejects.toThrow();
  });
});
