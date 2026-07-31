import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { logError } from "@/lib/log";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const upload = await prisma.upload.findUnique({
      where: { id },
      include: { jobs: true },
    });

    if (!upload) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: upload.id,
      title: upload.title,
      description: upload.description,
      fileName: upload.fileName,
      // Paired with each job's bytesUploaded, this is what turns the
      // platform-side transfer into a percentage the dashboard can show.
      fileSize: upload.fileSize,
      createdAt: upload.createdAt,
      jobs: upload.jobs.map((job) => ({
        id: job.id,
        platform: job.platform,
        status: job.status,
        resultUrl: job.resultUrl,
        error: job.error,
        // Narrowed back for JSON, which has no bigint. Safe: the value is a
        // byte offset into one video, far below Number's exact-integer range.
        bytesUploaded: job.bytesUploaded === null ? null : Number(job.bytesUploaded),
      })),
    });
  } catch (error) {
    const requestId = logError("uploads/[id].GET", error);
    return NextResponse.json({ error: "could not read upload status", requestId }, { status: 500 });
  }
}
