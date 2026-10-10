// Perpl position monitor (K5): a wallet's Perpl account and open positions, read onchain through the app's server RPC
// (one multicall), cached 5 s per wallet, backing off on 429. Read-only.
import { handlePositions } from "@/features/rates/perplRoutes";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => handlePositions(new URL(request.url));
