// Next 16 "proxy" (formerly middleware): restricted-jurisdiction check (C3). The decision is src/lib/geo.ts.
//   GEO_COUNTRY_HEADER    request header carrying the viewer's ISO country code, set by the hosting platform.
//                         > VERIFY: the header name for the platform we deploy on (its official docs); unset ⇒ no check.
//   GEO_BLOCKED_COUNTRIES comma-separated ISO 3166-1 alpha-2 codes, decided by the founders (unset ⇒ nobody).
//   GEO_BLOCK_MODE        "writes" (default: pages readable, writes refused in the app) | "all" (pages → /blocked).
import { NextResponse, type NextRequest } from "next/server";
import { GEO_COOKIE, GEO_RESTRICTED, geoDecision, parseCountryList, parseMode } from "@/lib/geo";

export function proxy(request: NextRequest) {
  const headerName = process.env.GEO_COUNTRY_HEADER;
  const decision = headerName
    ? geoDecision({
        country: request.headers.get(headerName),
        pathname: request.nextUrl.pathname,
        blocked: parseCountryList(process.env.GEO_BLOCKED_COUNTRIES),
        mode: parseMode(process.env.GEO_BLOCK_MODE),
      })
    : "allow";

  const res = decision === "block" ? NextResponse.rewrite(new URL("/blocked", request.url)) : NextResponse.next();
  if (decision === "allow") {
    if (request.cookies.has(GEO_COOKIE)) res.cookies.delete(GEO_COOKIE);
  } else {
    // readable by the client-side write gate (not a secret; the contracts stay permissionless either way)
    res.cookies.set(GEO_COOKIE, GEO_RESTRICTED, { path: "/", sameSite: "lax", secure: true, maxAge: 60 * 60 });
  }
  return res;
}

export const config = {
  // pages only: no static assets, images, the service worker or the manifest
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|.*\\.(?:png|svg|ico|json|js|css|txt)$).*)"],
};
