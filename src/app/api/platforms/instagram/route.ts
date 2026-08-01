import { NextResponse } from "next/server";
import { ensureSeedUser } from "@/lib/db";
import {
  disconnectInstagram,
  instagramConnectionStatus,
} from "@/lib/instagram-oauth";
import { logError } from "@/lib/log";

export async function GET() {
  try {
    const user = await ensureSeedUser();
    return NextResponse.json(await instagramConnectionStatus(user.id));
  } catch (error) {
    const requestId = logError("platforms/instagram.GET", error);
    return NextResponse.json(
      { error: "could not read Instagram connection status", requestId },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    const user = await ensureSeedUser();
    await disconnectInstagram(user.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const requestId = logError("platforms/instagram.DELETE", error);
    return NextResponse.json(
      { error: "could not disconnect Instagram", requestId },
      { status: 500 },
    );
  }
}
