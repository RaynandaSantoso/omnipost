import { NextResponse } from "next/server";
import { ensureSeedUser } from "@/lib/db";
import { startInstagramConnect } from "@/lib/instagram-oauth";
import { logError } from "@/lib/log";

export async function GET() {
  try {
    const user = await ensureSeedUser();
    return NextResponse.redirect(await startInstagramConnect(user.id));
  } catch (error) {
    const requestId = logError("platforms/instagram/connect", error);
    const message =
      error instanceof Error ? error.message : "Unable to start Instagram connection";
    return NextResponse.json({ error: message, requestId }, { status: 500 });
  }
}
