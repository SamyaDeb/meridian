// One viem public client per chain (HTTP; WebSocket only when EXPO_PUBLIC_MONAD_WS_URL is set). The URL is never
// logged: viem errors that embed it are passed through errText() before display.
import { createPublicClient, http, webSocket, type Chain, type PublicClient } from "viem";
import type { RpcConfig } from "../config";

const cache = new Map<string, PublicClient>();

export function publicClientFor(chain: Chain, rpc: RpcConfig): PublicClient {
  const key = `${chain.id}|${rpc.http}`;
  let c = cache.get(key);
  if (!c) {
    // batch: JSON-RPC calls made in the same tick share one HTTP request (fewer 429s on a public RPC)
    c = createPublicClient({ chain, transport: http(rpc.http, { batch: true, retryCount: 0, timeout: 8_000 }) }) as PublicClient;
    cache.set(key, c);
  }
  return c;
}

/** Head subscription over WS (viem watchBlockNumber); onError lets BlockSource fall back to polling. */
export function wsHeadSubscriber(chain: Chain, wsUrl: string) {
  return (onBlock: (b: bigint) => void, onError: (e: unknown) => void): (() => void) => {
    // reconnect off: a dead socket surfaces through onError and BlockSource falls back to polling
    const ws = createPublicClient({ chain, transport: webSocket(wsUrl, { retryCount: 0, reconnect: false }) });
    const unwatch = ws.watchBlockNumber({ emitOnBegin: true, onBlockNumber: onBlock, onError });
    return () => {
      unwatch();
      ws.transport.getRpcClient().then((r) => r.close(), () => undefined);
    };
  };
}
