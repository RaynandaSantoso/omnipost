import { JOB_STATUS, jobStatusFrom } from "@/lib/job-status";
import { platformSchema } from "@/lib/platform";
import { uploadPolicyFor } from "@/lib/platform-upload-policy";

export interface JobMetadataOverrides {
  platform: string;
  titleOverride: string | null;
  descriptionOverride: string | null;
}

export interface SharedUploadText {
  title: string;
  description: string;
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
    return { title: job.titleOverride, description: "" };
  }
  return {
    title: job.titleOverride ?? upload.title,
    description: job.descriptionOverride ?? upload.description,
  };
}
