import { NextResponse } from "next/server";
import { ensureSeedUser } from "@/lib/db";
import { disconnectYouTube, youtubeConnectionStatus } from "@/lib/youtube-oauth";
import { logError } from "@/lib/log";

export async function GET() {
  try {
    const user = await ensureSeedUser();
    return NextResponse.json(await youtubeConnectionStatus(user.id));
  } catch (error) {
    const requestId = logError("platforms/youtube.GET", error);
    return NextResponse.json({ error: "could not read YouTube connection status", requestId }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const user = await ensureSeedUser();
    await disconnectYouTube(user.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const requestId = logError("platforms/youtube.DELETE", error);
    return NextResponse.json({ error: "could not disconnect YouTube", requestId }, { status: 500 });
  }
}
