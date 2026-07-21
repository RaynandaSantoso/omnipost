import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { verifyPassword } from "@/lib/access-gate";
import { checkRateLimit, recordFailure, recordSuccess } from "@/lib/rate-limit";
import { issueSessionCookie, warnIfPlaintext } from "@/lib/session";

// The last hop in X-Forwarded-For is the address our own reverse proxy
// observed the connection from — the one hop the client can't forge.
// Earlier entries are whatever the client (or an upstream client) claimed,
// so taking the first hop would let an attacker mint a fresh rate-limit
// bucket on every request just by sending a different leading value.
function clientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) {
    return "unknown";
  }
  const hops = forwardedFor.split(",").map((hop) => hop.trim());
  return hops[hops.length - 1] || "unknown";
}

export async function POST(request: Request) {
  warnIfPlaintext(request);

  const config = getConfig();
  if (!config.ACCESS_PASSWORD) {
    return NextResponse.json(
      { error: "access gate is not enabled" },
      { status: 400 },
    );
  }

  const key = clientKey(request);
  const limit = checkRateLimit(key);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "too many attempts" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  let password: unknown;
  try {
    const body = await request.json();
    password = body?.password;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  if (typeof password !== "string" || !verifyPassword(password, config.ACCESS_PASSWORD)) {
    recordFailure(key);
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }

  recordSuccess(key);

  const response = NextResponse.json({ status: "ok" });
  issueSessionCookie(response, request, config.ACCESS_PASSWORD);
  return response;
}
