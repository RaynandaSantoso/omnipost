import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getJobEngine } from "@/lib/job-runner";
import { logError } from "@/lib/log";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job || job.status !== "failed") {
      return NextResponse.json({ error: "failed job not found" }, { status: 404 });
    }

    await getJobEngine().requestRetry(id);
    const retried = await prisma.job.findUniqueOrThrow({ where: { id } });
    return NextResponse.json({
      id: retried.id,
      status: retried.status,
      error: retried.error,
    });
  } catch (error) {
    const requestId = logError("jobs/[id]/retry", error);
    return NextResponse.json({ error: "could not retry job", requestId }, { status: 500 });
  }
}
