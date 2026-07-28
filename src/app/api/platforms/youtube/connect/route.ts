import { NextResponse } from "next/server";
import { ensureSeedUser } from "@/lib/db";
import { startYouTubeConnect } from "@/lib/youtube-oauth";
import { logError } from "@/lib/log";

export async function GET() {
  try {
    const user = await ensureSeedUser();
    return NextResponse.redirect(await startYouTubeConnect(user.id));
  } catch (error) {
    const requestId = logError("platforms/youtube/connect", error);
    const message = error instanceof Error ? error.message : "Unable to start YouTube connection";
    return NextResponse.json({ error: message, requestId }, { status: 500 });
  }
}
