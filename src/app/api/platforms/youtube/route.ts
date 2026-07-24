import { NextResponse } from "next/server";
import { ensureSeedUser } from "@/lib/db";
import { disconnectYouTube, youtubeConnectionStatus } from "@/lib/youtube-oauth";

export async function GET() {
  const user = await ensureSeedUser();
  return NextResponse.json(await youtubeConnectionStatus(user.id));
}

export async function DELETE() {
  const user = await ensureSeedUser();
  await disconnectYouTube(user.id);
  return new NextResponse(null, { status: 204 });
}
