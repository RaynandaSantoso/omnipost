export interface JobMetadataOverrides {
  platform: string;
  titleOverride: string | null;
  descriptionOverride: string | null;
}

export interface SharedUploadText {
  title: string;
  description: string;
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
import { platformSchema } from "@/lib/platform";
import { uploadPolicyFor } from "@/lib/platform-upload-policy";
