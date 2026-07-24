import { NextResponse } from "next/server";
import { ensureSeedUser } from "@/lib/db";
import { startYouTubeConnect } from "@/lib/youtube-oauth";

export async function GET() {
  try {
    const user = await ensureSeedUser();
    return NextResponse.redirect(await startYouTubeConnect(user.id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to start YouTube connection" }, { status: 500 });
  }
}
