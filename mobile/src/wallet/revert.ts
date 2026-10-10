// Why a transaction failed, in plain English (MOBILE_PLAN §0.4: never raw revert data). Decodes custom errors with the
// Meridian ABIs (plus Error(string) / Panic, which viem knows), and names the common node-side failures.
import { fullAbis } from "@meridian/core/meridian";
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, HttpRequestError, InsufficientFundsError, RawContractError, TimeoutError, type Abi, type Hex } from "viem";

/** Every custom error any Meridian contract can raise. */
export const meridianErrorsAbi: Abi = Object.values(fullAbis).flatMap((a) => a.filter((i) => i.type === "error"));

/** "InsufficientMargin" → "insufficient margin" */
export const humanize = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();

const hexData = (x: unknown): Hex | undefined => {
  const d = (x as { data?: unknown } | null)?.data;
  if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d)) return d as Hex;
  const inner = (d as { data?: unknown } | null | undefined)?.data;
  return typeof inner === "string" && /^0x[0-9a-fA-F]*$/.test(inner) ? (inner as Hex) : undefined;
};

/** Revert bytes anywhere in the cause chain (RawContractError from call, RpcRequestError.data from estimateGas). */
function revertData(e: BaseError): Hex | undefined {
  const hit = e.walk((x) => x instanceof RawContractError || hexData(x) !== undefined);
  return hit ? hexData(hit) : undefined;
}

function fromDecoded(name: string, args: readonly unknown[] | undefined): string {
  if (name === "Error" && typeof args?.[0] === "string") return `The contract refused: ${args[0]}.`;
  if (name === "Panic") return "The contract hit an internal error. Nothing changed.";
  return `The contract refused: ${humanize(name)}.`;
}

export function explainTxError(e: unknown, abi: Abi = meridianErrorsAbi): string {
  if (!(e instanceof BaseError)) return "The transaction failed. Try again.";
  if (e.walk((x) => x instanceof InsufficientFundsError)) return "Not enough MON to pay the network fee. Add MON and try again.";
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (reverted?.data?.errorName) return fromDecoded(reverted.data.errorName, reverted.data.args);
  if (reverted?.reason) return `The contract refused: ${reverted.reason}.`;
  const data = revertData(e);
  if (data && data !== "0x") {
    try {
      const d = decodeErrorResult({ abi, data });
      return fromDecoded(d.errorName, d.args as readonly unknown[] | undefined);
    } catch {
      return "The contract refused this transaction.";
    }
  }
  if (e.walk((x) => x instanceof TimeoutError || x instanceof HttpRequestError)) return "The network didn't answer. Check your connection and try again.";
  if (/revert/i.test(e.shortMessage)) return "The contract refused this transaction.";
  return "The transaction failed. Try again.";
}
