// sendTx against a fake JSON-RPC node (viem custom transport): what goes on the wire is asserted, nothing hits a network.
import { gasLimitFromEstimate } from "@meridian/core/meridian";
import { createPublicClient, createWalletClient, custom, encodeErrorResult, keccak256, parseTransaction, toHex, type Abi, type Hex, type PublicClient } from "viem";
import { monadTestnet } from "viem/chains";
import { openSigner } from "../../auth/derive";
import { explainTxError, humanize, meridianErrorsAbi } from "../../wallet/revert";
import { sendTx, TxError } from "../../wallet/sendTx";
import { SEQ_ADDRESS, seqPrf } from "../auth/authFixtures";

type Node = {
  estimate: bigint | { code: number; message: string; data?: Hex };
  status: "0x1" | "0x0";
  callRevert?: Hex;
  calls: { method: string; params: unknown[] }[];
  raw?: Hex;
};

function fakeNode(n: Node) {
  return custom(
    {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      n.calls.push({ method, params: params ?? [] });
      switch (method) {
        case "eth_chainId":
          return toHex(monadTestnet.id);
        case "eth_estimateGas":
          if (typeof n.estimate === "bigint") return toHex(n.estimate);
          throw n.estimate;
        case "eth_getTransactionCount":
          return "0x7";
        case "eth_blockNumber":
          return "0x10";
        case "eth_getBlockByNumber":
          return { number: "0x10", baseFeePerGas: toHex(50_000_000_000n), hash: `0x${"11".repeat(32)}`, timestamp: "0x1", transactions: [] };
        case "eth_maxPriorityFeePerGas":
          return toHex(2_000_000_000n);
        case "eth_sendRawTransaction":
          n.raw = (params as Hex[])[0]!;
          return keccak256(n.raw!);
        case "eth_getTransactionReceipt":
          return {
            blockHash: `0x${"22".repeat(32)}`,
            blockNumber: "0x10",
            contractAddress: null,
            cumulativeGasUsed: "0x5208",
            effectiveGasPrice: "0x1",
            from: SEQ_ADDRESS.toLowerCase(),
            gasUsed: "0x5208",
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            status: n.status,
            to: SEQ_ADDRESS.toLowerCase(),
            transactionHash: keccak256(n.raw!),
            transactionIndex: "0x0",
            type: "0x2",
          };
        case "eth_call":
          throw { code: 3, message: "execution reverted", data: n.callRevert ?? "0x" };
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
    },
    { retryCount: 0 },
  );
}

function setup(n: Node) {
  const signer = openSigner(seqPrf());
  const transport = fakeNode(n);
  const pub = createPublicClient({ chain: monadTestnet, transport, pollingInterval: 5 }) as PublicClient;
  const wallet = createWalletClient({ account: signer.account, chain: monadTestnet, transport });
  return { pub, wallet, signer };
}

type AbiError = Extract<Abi[number], { type: "error" }>;
const someError = meridianErrorsAbi.find((e): e is AbiError => e.type === "error" && e.inputs.length === 0)!;

describe("sendTx", () => {
  it("0-value self-transfer: gas = ceil(estimate × 1.2), pending nonce, explicit chain id, EIP-1559 fees, receipt", async () => {
    const n: Node = { estimate: 21_001n, status: "0x1", calls: [] };
    const { pub, wallet, signer } = setup(n);
    const r = await sendTx(pub, wallet, { to: signer.address, value: 0n }, { pollingInterval: 5 });
    expect(r.gasEstimate).toBe(21_001n);
    expect(r.gasLimit).toBe(25_202n); // 25,201.2 → 25,202 (rounded up)
    expect(gasLimitFromEstimate(21_000n)).toBe(25_200n);
    const nonceCall = n.calls.find((c) => c.method === "eth_getTransactionCount")!;
    expect(nonceCall.params[1]).toBe("pending");
    const tx = parseTransaction(n.raw!);
    expect(tx).toMatchObject({ type: "eip1559", chainId: 10143, gas: 25_202n, nonce: 7, to: signer.address.toLowerCase(), maxPriorityFeePerGas: 2_000_000_000n });
    expect(tx.maxFeePerGas).toBeGreaterThan(50_000_000_000n);
    expect(r).toMatchObject({ hash: keccak256(n.raw!), blockNumber: 16n, gasUsed: 21_000n, nonce: 7 });
    // estimateGas ran before the nonce / send, and only one tx went out
    const order = n.calls.map((c) => c.method);
    expect(order.indexOf("eth_estimateGas")).toBeLessThan(order.indexOf("eth_sendRawTransaction"));
    expect(order.filter((m) => m === "eth_sendRawTransaction")).toHaveLength(1);
    signer.session.end();
  });

  it("a revert at estimate time is decoded to plain English and nothing is sent", async () => {
    const data = encodeErrorResult({ abi: [someError], errorName: someError.name });
    const n: Node = { estimate: { code: 3, message: "execution reverted", data }, status: "0x1", calls: [] };
    const { pub, wallet, signer } = setup(n);
    await expect(sendTx(pub, wallet, { to: signer.address })).rejects.toEqual(new TxError(`The contract refused: ${humanize(someError.name)}.`));
    expect(n.calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(false);
    signer.session.end();
  });

  it("a mined revert is re-simulated at its block and decoded; the hash is kept", async () => {
    const n: Node = { estimate: 50_000n, status: "0x0", callRevert: encodeErrorResult({ abi: [someError], errorName: someError.name }), calls: [] };
    const { pub, wallet, signer } = setup(n);
    const e = await sendTx(pub, wallet, { to: signer.address, data: "0x1234" }, { pollingInterval: 5 }).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(TxError);
    expect((e as TxError).message).toBe(`The contract refused: ${humanize(someError.name)}.`);
    expect((e as TxError).hash).toBe(keccak256(n.raw!));
    const call = n.calls.find((c) => c.method === "eth_call")!;
    expect(call.params[1]).toBe("0x10");
    signer.session.end();
  });

  it("not enough MON for the fee → says so", async () => {
    const n: Node = { estimate: { code: -32000, message: "insufficient funds for gas * price + value" }, status: "0x1", calls: [] };
    const { pub, wallet, signer } = setup(n);
    await expect(sendTx(pub, wallet, { to: signer.address, value: 1n })).rejects.toThrow("Not enough MON to pay the network fee. Add MON and try again.");
    signer.session.end();
  });

  it("Error(string) reasons and unknown errors", () => {
    expect(humanize("InsufficientMargin")).toBe("insufficient margin");
    expect(humanize("OIExceedsCap")).toBe("oi exceeds cap");
    expect(explainTxError(new Error("x"))).toBe("The transaction failed. Try again.");
  });
});
