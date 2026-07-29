import { NextResponse } from "next/server";
import { completeTikTokConnect } from "@/lib/tiktok-oauth";
import { logError } from "@/lib/log";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return NextResponse.json({ error: "OAuth callback requires code and state" }, { status: 400 });
  try {
    await completeTikTokConnect(request.url, code, state);
    return NextResponse.redirect(new URL("/?tiktok=connected", url));
  } catch (error) {
    const requestId = logError("platforms/tiktok/callback", error);
    const message = error instanceof Error ? error.message : "Unable to connect TikTok";
    const status = /state|redirect URI/i.test(message) ? 400 : 502;
    return NextResponse.json({ error: message, requestId }, { status });
  }
}
