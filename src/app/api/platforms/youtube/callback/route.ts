import { NextResponse } from "next/server";
import { completeYouTubeConnect } from "@/lib/youtube-oauth";
import { logError } from "@/lib/log";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return NextResponse.json({ error: "OAuth callback requires code and state" }, { status: 400 });
  try {
    await completeYouTubeConnect(request.url, code, state);
    return NextResponse.redirect(new URL("/?youtube=connected", url));
  } catch (error) {
    const requestId = logError("platforms/youtube/callback", error);
    const message = error instanceof Error ? error.message : "Unable to connect YouTube";
    const status = /state|redirect URI/i.test(message) ? 400 : 502;
    return NextResponse.json({ error: message, requestId }, { status });
  }
}
