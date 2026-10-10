// K6 B4: GET /api/health → which production settings are present (booleans only, lib/health.ts). No values, no secrets.
import { healthReport } from "@/lib/health";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(healthReport(process.env), { headers: { "cache-control": "no-store" } });
}
