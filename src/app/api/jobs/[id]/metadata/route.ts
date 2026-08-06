import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jobMetadataState, jobMetadataViolation, sharedUploadText } from "@/lib/job-metadata";
import { logError } from "@/lib/log";
import { platformSchema } from "@/lib/platform";
import { platformTextOverrideViolation } from "@/lib/platform-upload-policy";

const metadataUpdateSchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  hashtags: z.array(z.string()).nullable().optional(),
}).strict().refine(
  (value) => value.title !== undefined || value.description !== undefined || value.hashtags !== undefined,
  { message: "provide a title, description, or hashtags override" },
);

type JobWithUpload = NonNullable<Awaited<ReturnType<typeof findJob>>>;

function findJob(id: string) {
  return prisma.job.findUnique({ where: { id }, include: { upload: true } });
}

function metadataView(job: JobWithUpload) {
  const metadata = jobMetadataState(job, sharedUploadText(job.upload));
  return {
    id: job.id,
    platform: job.platform,
    status: job.status,
    ...metadata,
    source: metadata.overrideSource,
    effective: metadata.savedMetadata,
    appliesTo: metadata.metadataAppliesTo,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const job = await findJob(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json(metadataView(job));
  } catch (error) {
    const requestId = logError("jobs/[id]/metadata.GET", error);
    return NextResponse.json({ error: "could not read Job metadata", requestId }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "metadata must be valid JSON" }, { status: 400 });
  }
  const parsed = metadataUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid metadata" }, { status: 400 });
  }

  try {
    const current = await findJob(id);
    if (!current) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    const title = parsed.data.title === undefined ? current.titleOverride : parsed.data.title;
    const description = parsed.data.description === undefined
      ? current.descriptionOverride
      : parsed.data.description;
    const hashtags = parsed.data.hashtags === undefined
      ? current.hashtagsOverride
      : parsed.data.hashtags === null ? null : JSON.stringify(parsed.data.hashtags);
    const platform = platformSchema.safeParse(current.platform);
    if (!platform.success) {
      return NextResponse.json({ error: "this Job has an unsupported platform" }, { status: 400 });
    }
    const validationError = platformTextOverrideViolation(platform.data, { title, description });
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    // The fields above are what the operator typed; this is what the platform
    // would receive once the hashtags are composed in. Both are checked
    // because neither implies the other.
    const composedViolation = jobMetadataViolation(
      { platform: current.platform, titleOverride: title, descriptionOverride: description, hashtagsOverride: hashtags },
      sharedUploadText(current.upload),
    );
    if (composedViolation) {
      return NextResponse.json({ error: composedViolation }, { status: 400 });
    }

    const updated = await prisma.job.update({
      where: { id },
      data: { titleOverride: title, descriptionOverride: description, hashtagsOverride: hashtags },
      include: { upload: true },
    });
    return NextResponse.json(metadataView(updated));
  } catch (error) {
    const requestId = logError("jobs/[id]/metadata.PATCH", error);
    return NextResponse.json({ error: "could not update Job metadata", requestId }, { status: 500 });
  }
}
