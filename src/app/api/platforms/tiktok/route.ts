import { NextResponse } from "next/server";
import { ensureSeedUser } from "@/lib/db";
import { disconnectTikTok, tiktokConnectionStatus } from "@/lib/tiktok-oauth";
import { logError } from "@/lib/log";

export async function GET() {
  try {
    const user = await ensureSeedUser();
    return NextResponse.json(await tiktokConnectionStatus(user.id));
  } catch (error) {
    const requestId = logError("platforms/tiktok.GET", error);
    return NextResponse.json({ error: "could not read TikTok connection status", requestId }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const user = await ensureSeedUser();
    await disconnectTikTok(user.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const requestId = logError("platforms/tiktok.DELETE", error);
    return NextResponse.json({ error: "could not disconnect TikTok", requestId }, { status: 500 });
  }
}
