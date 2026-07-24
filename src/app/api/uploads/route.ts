import { NextResponse } from "next/server";
import { ensureSeedUser, prisma } from "@/lib/db";
import { createUpload } from "@/lib/uploads";

export async function GET() {
  const uploads = await prisma.upload.findMany({
    include: { jobs: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(uploads.map((upload) => ({
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
  })));
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("video");
  const title = formData.get("title");
  const description = formData.get("description");

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { error: "a video file is required" },
      { status: 400 },
    );
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json(
      { error: "a title is required" },
      { status: 400 },
    );
  }
  if (typeof description !== "string") {
    return NextResponse.json(
      { error: "a description is required" },
      { status: 400 },
    );
  }

  const user = await ensureSeedUser();
  const upload = await createUpload({ userId: user.id, title, description, file });

  return NextResponse.json(
    {
      id: upload.id,
      jobs: upload.jobs.map((job) => ({
        id: job.id,
        platform: job.platform,
        status: job.status,
        resultUrl: job.resultUrl,
        error: job.error,
      })),
    },
    { status: 201 },
  );
}
