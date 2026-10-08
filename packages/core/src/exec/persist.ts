// Persisted exec state: versioned, bigint-safe JSON (util/json), validated on load so a corrupt or foreign blob never
// drives an order. Holds no key material (refs are rq numbers / tx hashes). The app writes it after every event.
import { parseBig, stringifyBig } from "../util/json";
import { BASIS_PHASES, type BasisExecState } from "./basis";
import { CLOSE_PHASES, type CloseExecState } from "./close";
import { SINGLE_PHASES, type SingleState } from "./single";

export type ExecState = SingleState | BasisExecState | CloseExecState;
export const EXEC_STATE_VERSION = 1;

export const serializeExec = (s: ExecState): string => stringifyBig({ format: "meridian-exec", ...s });

export class ExecStateError extends Error {
  override name = "ExecStateError";
}

export function deserializeExec(text: string): ExecState {
  let o: unknown;
  try {
    o = parseBig(text);
  } catch (e) {
    throw new ExecStateError(`not exec state JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof o !== "object" || o === null) throw new ExecStateError("not an object");
  const { format, ...rest } = o as Record<string, unknown>;
  if (format !== "meridian-exec") throw new ExecStateError("not a Meridian exec state");
  if (rest.v !== EXEC_STATE_VERSION) throw new ExecStateError(`unsupported exec state version ${String(rest.v)}`);
  if (typeof rest.id !== "string" || rest.id === "") throw new ExecStateError("missing id");
  const phases = rest.kind === "single" ? SINGLE_PHASES : rest.kind === "basis" ? BASIS_PHASES : rest.kind === "close" ? CLOSE_PHASES : undefined;
  if (!phases) throw new ExecStateError(`unknown kind ${String(rest.kind)}`);
  if (!(phases as readonly unknown[]).includes(rest.phase)) throw new ExecStateError(`unknown ${String(rest.kind)} phase ${String(rest.phase)}`);
  const leg = rest.leg as { ref?: unknown; sent?: unknown } | undefined;
  if (!leg || typeof leg.sent !== "boolean" || (leg.ref !== undefined && typeof leg.ref !== "string")) throw new ExecStateError("bad leg progress");
  return rest as unknown as ExecState;
}
