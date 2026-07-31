import { NextResponse } from "next/server";
import { completeTikTokConnect } from "@/lib/tiktok-oauth";
import { logError } from "@/lib/log";

function lastForwardedValue(value: string | null): string | null {
  return value?.split(",").at(-1)?.trim() || null;
}

function externallyVisibleUrl(request: Request): URL {
  const url = new URL(request.url);
  const forwardedHost = lastForwardedValue(
    request.headers.get("x-forwarded-host"),
  );
  const forwardedProtocol = lastForwardedValue(
    request.headers.get("x-forwarded-proto"),
  );

  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? `${forwardedProtocol}:`
      : url.protocol;
  const host = forwardedHost ?? url.host;
  return new URL(`${url.pathname}${url.search}${url.hash}`, `${protocol}//${host}`);
}

export async function GET(request: Request) {
  const url = externallyVisibleUrl(request);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return NextResponse.json({ error: "OAuth callback requires code and state" }, { status: 400 });
  try {
    await completeTikTokConnect(url.href, code, state);
    return NextResponse.redirect(new URL("/?tiktok=connected", url));
  } catch (error) {
    const requestId = logError("platforms/tiktok/callback", error);
    const message = error instanceof Error ? error.message : "Unable to connect TikTok";
    const status = /state|redirect URI/i.test(message) ? 400 : 502;
    return NextResponse.json({ error: message, requestId }, { status });
  }
}
