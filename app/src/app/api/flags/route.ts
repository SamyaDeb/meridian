// Remote flags for the web app and the native app (LAUNCH_PLAN §3.3). Env-backed (FLAGS_*), read per request so a
// Vercel env change + redeploy takes effect without a client rebuild; cached at the edge for 30 s.
import { FLAGS_HEADERS, readFlagsEnv } from "@/lib/flags";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(readFlagsEnv(process.env), { status: 200, headers: FLAGS_HEADERS });
}
