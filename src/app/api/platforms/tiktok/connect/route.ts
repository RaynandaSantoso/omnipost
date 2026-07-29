import { NextResponse } from "next/server";
import { ensureSeedUser } from "@/lib/db";
import { startTikTokConnect } from "@/lib/tiktok-oauth";
import { logError } from "@/lib/log";

export async function GET() {
  try {
    const user = await ensureSeedUser();
    return NextResponse.redirect(await startTikTokConnect(user.id));
  } catch (error) {
    const requestId = logError("platforms/tiktok/connect", error);
    const message = error instanceof Error ? error.message : "Unable to start TikTok connection";
    return NextResponse.json({ error: message, requestId }, { status: 500 });
  }
}
