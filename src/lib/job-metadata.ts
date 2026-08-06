import { JOB_STATUS, jobStatusFrom } from "@/lib/job-status";
import { platformSchema } from "@/lib/platform";
import {
  applyHashtags,
  composedCaptionViolation,
  uploadPolicyFor,
} from "@/lib/platform-upload-policy";

export interface JobMetadataOverrides {
  platform: string;
  titleOverride: string | null;
  descriptionOverride: string | null;
  // JSON-encoded string array, same encoding as Upload.hashtags. Null (or
  // absent) means inherit the Upload's shared hashtag set.
  hashtagsOverride?: string | null;
}

export interface SharedUploadText {
  title: string;
  description: string;
  hashtags?: string[];
}

// Both Upload.hashtags and Job.hashtagsOverride store the same JSON-encoded
// string-array shape. An unparseable value falls back to an empty array
// rather than throwing, since it should never happen past the write-side
// validation but shouldn't break a status read either.
function parseHashtagArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string")) {
      return parsed;
    }
  } catch {
    // fall through to no hashtags
  }
  return [];
}

// Turns a raw Upload row into the shape resolveJobMetadata/jobMetadataState
// expect.
export function sharedUploadText(
  upload: { title: string; description: string; hashtags: string },
): SharedUploadText {
  return {
    title: upload.title,
    description: upload.description,
    hashtags: parseHashtagArray(upload.hashtags),
  };
}

// null means the Job inherits the Upload's shared hashtag set; a non-null
// value (including "[]") replaces it entirely for this Job only.
export function jobHashtagsOverride(raw: string | null | undefined): string[] | null {
  return raw == null ? null : parseHashtagArray(raw);
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
  const overrideSource = job.titleOverride === null
    && job.descriptionOverride === null
    && job.hashtagsOverride == null
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
    hashtagsOverride: jobHashtagsOverride(job.hashtagsOverride),
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

/**
 * Whether what this Job would send breaks its platform's text limits.
 *
 * Resolution runs first on purpose. Which hashtags apply, whether a caption
 * override displaces them, and how they join the description are all decided
 * by `resolveJobMetadata` — so measuring anything earlier measures a string
 * the adapter is never handed. Overrides and the Upload's shared text are
 * checked on identical terms because the composed result is the only thing
 * the platform sees, and it does not care which half an operator typed.
 */
export function jobMetadataViolation(
  job: JobMetadataOverrides,
  upload: SharedUploadText,
): string | null {
  const platform = platformSchema.safeParse(job.platform);
  // An unrecognised platform has no limits to check against. The write paths
  // reject it on their own terms; this is not the place to discover it.
  if (!platform.success) return null;
  return composedCaptionViolation(platform.data, resolveJobMetadata(job, upload));
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
  const hashtags = jobHashtagsOverride(job.hashtagsOverride) ?? upload.hashtags ?? [];
  if (!platform.success || !hashtags.length) return resolved;
  return applyHashtags(platform.data, resolved, hashtags);
}
