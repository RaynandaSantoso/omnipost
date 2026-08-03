import { JOB_STATUS, jobStatusFrom } from "@/lib/job-status";
import { platformSchema } from "@/lib/platform";
import { applyHashtags, uploadPolicyFor } from "@/lib/platform-upload-policy";

export interface JobMetadataOverrides {
  platform: string;
  titleOverride: string | null;
  descriptionOverride: string | null;
}

export interface SharedUploadText {
  title: string;
  description: string;
  hashtags?: string[];
}

// Upload.hashtags is stored as a JSON-encoded string column (see
// prisma/schema.prisma); this turns a raw Upload row into the shape
// resolveJobMetadata/jobMetadataState expect. An unparseable value falls
// back to no hashtags rather than throwing, since it should never happen
// past the write-side validation but shouldn't break a status read either.
export function sharedUploadText(
  upload: { title: string; description: string; hashtags: string },
): SharedUploadText {
  let hashtags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(upload.hashtags);
    if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string")) {
      hashtags = parsed;
    }
  } catch {
    // fall through to no hashtags
  }
  return { title: upload.title, description: upload.description, hashtags };
}

export function jobMetadataState(
  job: JobMetadataOverrides & {
    status: string;
    resolvedTitle?: string | null;
    resolvedDescription?: string | null;
    resolvedFromOverride?: boolean | null;
  },
  upload: SharedUploadText,
) {
  const status = jobStatusFrom(job.status);
  const overrideSource = job.titleOverride === null && job.descriptionOverride === null
    ? "shared" as const
    : "overridden" as const;
  const hasActiveAttemptSnapshot =
    status === JOB_STATUS.uploading &&
    job.resolvedTitle != null &&
    job.resolvedDescription != null &&
    job.resolvedFromOverride != null;
  const savedMetadata = resolveJobMetadata(job, upload);
  return {
    titleOverride: job.titleOverride,
    descriptionOverride: job.descriptionOverride,
    overrideSource,
    savedMetadata,
    metadataSource: hasActiveAttemptSnapshot
      ? job.resolvedFromOverride ? "overridden" as const : "shared" as const
      : overrideSource,
    effectiveMetadata: hasActiveAttemptSnapshot
      ? { title: job.resolvedTitle!, description: job.resolvedDescription! }
      : savedMetadata,
    metadataAppliesTo: status === JOB_STATUS.uploading
      ? "future-attempt" as const
      : "next-attempt" as const,
  };
}

export function resolveJobMetadata(
  job: JobMetadataOverrides,
  upload: SharedUploadText,
): SharedUploadText {
  const platform = platformSchema.safeParse(job.platform);
  if (
    platform.success &&
    uploadPolicyFor(platform.data).text.kind === "caption" &&
    job.titleOverride !== null
  ) {
    // A caption override is already-finished outbound text; the shared
    // hashtag set isn't composed a second time on top of it.
    return { title: job.titleOverride, description: "" };
  }
  const resolved = {
    title: job.titleOverride ?? upload.title,
    description: job.descriptionOverride ?? upload.description,
  };
  if (!platform.success || !upload.hashtags?.length) return resolved;
  return applyHashtags(platform.data, resolved, upload.hashtags);
}
