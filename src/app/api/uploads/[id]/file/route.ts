import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { prisma } from "@/lib/db";
import { logError } from "@/lib/log";
import { verifyPublicMediaToken } from "@/lib/public-media";

const CONTENT_TYPES: Record<string, string> = {
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function downloadDisposition(fileName: string): string {
  const safeName = path.basename(fileName).replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${safeName}"`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("token");
  if (!token || !verifyPublicMediaToken(id, token)) {
    return new Response(null, { status: 404 });
  }

  try {
    const upload = await prisma.upload.findUnique({ where: { id } });
    if (!upload) return new Response(null, { status: 404 });

    const file = await stat(upload.filePath);
    if (!file.isFile()) return new Response(null, { status: 404 });
    const stream = Readable.toWeb(createReadStream(upload.filePath));
    const contentType = CONTENT_TYPES[path.extname(upload.fileName).toLowerCase()];

    return new Response(stream as ReadableStream, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": downloadDisposition(upload.fileName),
        "Content-Length": String(file.size),
        "Content-Type": contentType ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Response(null, { status: 404 });
    }
    const requestId = logError("uploads/[id]/file.GET", error);
    return Response.json({ error: "could not serve upload", requestId }, { status: 500 });
  }
}
