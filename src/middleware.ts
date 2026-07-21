import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  issueSessionCookie,
  SESSION_COOKIE_NAME,
  verifySessionToken,
  warnIfPlaintext,
} from "@/lib/session";

// Constant-time password compare and HMAC signing need Node's crypto, not
// the Edge runtime's Web Crypto subset — run middleware on Node.
export const runtime = "nodejs";

// Reachable without a session: the login page and its API, and health,
// which orchestrators/healthchecks must be able to poll without a cookie.
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/health"]);

function withRenewedSession(request: NextRequest, password: string): NextResponse {
  const response = NextResponse.next();
  issueSessionCookie(response, request, password);
  return response;
}

export function middleware(request: NextRequest) {
  warnIfPlaintext(request);

  const appConfig = getConfig();
  if (!appConfig.ACCESS_PASSWORD) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token && verifySessionToken(token, appConfig.ACCESS_PASSWORD)) {
    return withRenewedSession(request, appConfig.ACCESS_PASSWORD);
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
