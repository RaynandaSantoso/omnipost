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
      createdAt: upload.createdAt,
      jobs: upload.jobs.map((job) => ({
        id: job.id,
        platform: job.platform,
        status: job.status,
        resultUrl: job.resultUrl,
        error: job.error,
      })),
    });
  } catch (error) {
    const requestId = logError("uploads/[id].GET", error);
    return NextResponse.json({ error: "could not read upload status", requestId }, { status: 500 });
  }
}
