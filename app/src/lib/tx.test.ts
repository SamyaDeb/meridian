import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, type Log, type PublicClient, type WalletClient } from "viem";
import { erc20Abi } from "./abi";
import { assertReceiptSuccess, isSponsoredWallet, sendTx, withSponsoredSend, type SponsoredCall } from "./tx";
import { SPONSOR_UNAVAILABLE, SponsorError } from "./sponsor";

const ME = "0x00000000000000000000000000000000000000aa" as const;
const TOKEN = "0x00000000000000000000000000000000000000bb" as const;
const SPENDER = "0x00000000000000000000000000000000000000cc" as const;
const HASH = `0x${"11".repeat(32)}` as const;
const req = { address: TOKEN, abi: erc20Abi, functionName: "approve", args: [SPENDER, 5n] } as const;

function fakes(o: { estimate?: bigint; status?: "success" | "reverted"; logs?: Log[] } = {}) {
  const pub = {
    estimateContractGas: vi.fn(async () => o.estimate ?? 101n),
    getChainId: vi.fn(async () => 10143),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: `0x${string}` }) => ({ status: o.status ?? "success", blockNumber: 7n, gasUsed: 90n, logs: o.logs ?? [], transactionHash: hash })),
  };
  const wallet = { account: { address: ME }, chain: { id: 10143 }, writeContract: vi.fn<(a: Record<string, unknown>) => Promise<typeof HASH>>(async () => HASH) };
  return { pub, wallet, p: pub as unknown as PublicClient, w: wallet as unknown as WalletClient };
}

const userOpAbi = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
function userOpLog(sender: `0x${string}`, success: boolean): Log {
  const topics = encodeEventTopics({ abi: userOpAbi, eventName: "UserOperationEvent", args: { userOpHash: HASH, sender, paymaster: SPENDER } });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, success, 1n, 1n]);
  return { address: SPENDER, topics: topics as Log["topics"], data, blockHash: HASH, blockNumber: 7n, logIndex: 0, transactionHash: HASH, transactionIndex: 0, removed: false };
}

describe("sendTx routing (K1.2)", () => {
  it("unsponsored ⇒ the wallet's writeContract with gas = estimate × 1.2 rounded up", async () => {
    const f = fakes({ estimate: 101n });
    const r = await sendTx(f.p, f.w, req);
    expect(f.wallet.writeContract).toHaveBeenCalledTimes(1);
    expect(f.wallet.writeContract.mock.calls[0]![0]).toMatchObject({ address: TOKEN, functionName: "approve", gas: 122n }); // 121.2 → 122
    expect(r).toEqual({ hash: HASH, block: 7n, gasUsed: 90n, gasLimit: 122n });
    expect(f.pub.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it("sponsored ⇒ the sponsored sender gets the encoded call and the same gas limit; writeContract is never used", async () => {
    const f = fakes({ estimate: 100n });
    const send = vi.fn<(c: SponsoredCall) => Promise<typeof HASH>>(async () => HASH);
    const sw = withSponsoredSend(f.w, send);
    expect(isSponsoredWallet(sw)).toBe(true);
    expect(isSponsoredWallet(f.w)).toBe(false); // the original client is never re-routed
    const r = await sendTx(f.p, sw, req);
    expect(f.wallet.writeContract).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      from: ME,
      to: TOKEN,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SPENDER, 5n] }),
      value: 0n,
      gas: 120n,
      chainId: 10143,
    });
    expect(r).toEqual({ hash: HASH, block: 7n, gasUsed: 90n, gasLimit: 120n });
  });

  it("both paths check the receipt", async () => {
    const a = fakes({ status: "reverted" });
    await expect(sendTx(a.p, a.w, req)).rejects.toThrow(/reverted/);
    const b = fakes({ status: "reverted" });
    await expect(sendTx(b.p, withSponsoredSend(b.w, async () => HASH), req)).rejects.toThrow(/reverted/);
  });

  it("a bundled call whose inner operation failed is a revert, even if the outer tx succeeded", async () => {
    const f = fakes({ logs: [userOpLog(ME, false)] });
    await expect(sendTx(f.p, withSponsoredSend(f.w, async () => HASH), req)).rejects.toThrow(/reverted/);
    const ok = fakes({ logs: [userOpLog(ME, true), userOpLog(SPENDER, false)] }); // another sender's failure isn't ours
    await expect(sendTx(ok.p, withSponsoredSend(ok.w, async () => HASH), req)).resolves.toMatchObject({ hash: HASH });
  });

  it("refused sponsorship ⇒ SponsorError with the free-gas message, never a paid fallback", async () => {
    const f = fakes();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sw = withSponsoredSend(f.w, async () => {
      throw new Error("Gas sponsorship quota exceeded");
    });
    const e = await sendTx(f.p, sw, req).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SponsorError);
    expect((e as Error).message).toBe(SPONSOR_UNAVAILABLE);
    expect(f.wallet.writeContract).not.toHaveBeenCalled();
    expect(f.pub.waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a user cancel on the sponsored path is passed through unchanged", async () => {
    const f = fakes();
    const sw = withSponsoredSend(f.w, async () => {
      throw new Error("User rejected the request.");
    });
    await expect(sendTx(f.p, sw, req)).rejects.toThrow("User rejected the request.");
  });

  it("no account ⇒ refuses before estimating", async () => {
    const f = fakes();
    await expect(sendTx(f.p, { ...f.wallet, account: undefined } as unknown as WalletClient, req)).rejects.toThrow(/not connected/);
    expect(f.pub.estimateContractGas).not.toHaveBeenCalled();
  });
});

describe("assertReceiptSuccess", () => {
  it("passes a plain successful receipt", () => {
    expect(() => assertReceiptSuccess({ status: "success", logs: [], transactionHash: HASH }, ME)).not.toThrow();
  });
});
