// Perpl's MON market now (rate in force, last funding block, mark, OI, fees, margins), read onchain, cached 5 s. Read-only.
import { handleMarket } from "@/features/rates/perplRoutes";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => handleMarket(new URL(request.url));
