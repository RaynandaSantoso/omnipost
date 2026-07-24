import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getJobEngine } from "@/lib/job-runner";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
}
