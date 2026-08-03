import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureSeedUser, prisma } from "@/lib/db";
import { createUpload, UploadValidationError } from "@/lib/uploads";
import { platformSchema, type Platform } from "@/lib/platform";
import { logError } from "@/lib/log";
import type { PlatformTextOverrides } from "@/lib/platform-upload-policy";
import { jobMetadataState, sharedUploadText } from "@/lib/job-metadata";

const textOverrideSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
}).strict();

function hashtagsFrom(formData: FormData): string[] | NextResponse {
  const raw = formData.get("hashtags");
  if (raw === null) return [];
  if (typeof raw !== "string") {
    return NextResponse.json({ error: "hashtags must be JSON text" }, { status: 400 });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "hashtags must be valid JSON" }, { status: 400 });
  }
  const parsed = z.array(z.string()).safeParse(value);
  if (!parsed.success) {
    return NextResponse.json({ error: "hashtags must be an array of strings" }, { status: 400 });
  }
  return parsed.data;
}

function overridesFrom(formData: FormData): PlatformTextOverrides | NextResponse {
  const raw = formData.get("overrides");
  if (raw === null) return {};
  if (typeof raw !== "string") {
    return NextResponse.json({ error: "overrides must be JSON text" }, { status: 400 });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "overrides must be valid JSON" }, { status: 400 });
  }
  const record = z.record(z.string(), textOverrideSchema).safeParse(value);
  if (!record.success) {
    return NextResponse.json({ error: "overrides must map platforms to text fields" }, { status: 400 });
  }

  const overrides: PlatformTextOverrides = {};
  for (const [valuePlatform, override] of Object.entries(record.data)) {
    const parsedPlatform = platformSchema.safeParse(valuePlatform);
    if (!parsedPlatform.success) {
      return NextResponse.json(
        { error: `unsupported override platform "${valuePlatform}"` },
        { status: 400 },
      );
    }
    overrides[parsedPlatform.data] = override;
  }
  return overrides;
}

export async function GET() {
  try {
    const uploads = await prisma.upload.findMany({
      include: { jobs: true },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(uploads.map((upload) => ({
      id: upload.id,
      title: upload.title,
      description: upload.description,
      hashtags: sharedUploadText(upload).hashtags,
      fileName: upload.fileName,
      createdAt: upload.createdAt,
      jobs: upload.jobs.map((job) => ({
        id: job.id,
        platform: job.platform,
        status: job.status,
        resultUrl: job.resultUrl,
        error: job.error,
        ...jobMetadataState(job, sharedUploadText(upload)),
      })),
    })));
  } catch (error) {
    const requestId = logError("uploads.GET", error);
    return NextResponse.json({ error: "could not list uploads", requestId }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    const requestId = logError("uploads.POST.parse", error);
    return NextResponse.json(
      { error: "the upload request body could not be read — the file may exceed the configured size limit", requestId },
      { status: 400 },
    );
  }

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

  const platformField = formData.get("platform");
  let platform: Platform | undefined;
  if (platformField !== null) {
    if (typeof platformField !== "string") {
      return NextResponse.json({ error: "platform must be a string" }, { status: 400 });
    }
    const parsed = platformSchema.safeParse(platformField);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `unsupported platform "${platformField}"` },
        { status: 400 },
      );
    }
    platform = parsed.data;
  }

  const overrides = overridesFrom(formData);
  if (overrides instanceof NextResponse) return overrides;

  const hashtags = hashtagsFrom(formData);
  if (hashtags instanceof NextResponse) return hashtags;

  try {
    const user = await ensureSeedUser();
    const upload = await createUpload({ userId: user.id, title, description, file, platform, overrides, hashtags });

    return NextResponse.json(
      {
        id: upload.id,
        title: upload.title,
        description: upload.description,
        hashtags: sharedUploadText(upload).hashtags,
        fileName: upload.fileName,
        fileSize: upload.fileSize,
        createdAt: upload.createdAt,
        jobs: upload.jobs.map((job) => ({
          id: job.id,
          platform: job.platform,
          status: job.status,
          resultUrl: job.resultUrl,
          error: job.error,
          ...jobMetadataState(job, sharedUploadText(upload)),
        })),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const requestId = logError("uploads.POST", error);
    return NextResponse.json({ error: "the upload could not be created", requestId }, { status: 500 });
  }
}
