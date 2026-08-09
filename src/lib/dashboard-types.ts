import type { AuthoredText } from "@/lib/platform-upload-policy";
import type { Platform } from "@/lib/platform";

export interface JobView {
  id: string;
  platform: Platform;
  status: "pending" | "uploading" | "done" | "failed";
  resultUrl: string | null;
  error: string | null;
  bytesUploaded?: number | null;
  titleOverride?: string | null;
  descriptionOverride?: string | null;
  hashtagsOverride?: string[] | null;
  metadataSource?: "shared" | "overridden";
  overrideSource?: "shared" | "overridden";
  effectiveMetadata?: AuthoredText;
  savedMetadata?: AuthoredText;
  metadataAppliesTo?: "next-attempt" | "future-attempt";
}

export interface UploadView {
  id: string;
  title?: string;
  description?: string;
  hashtags?: string[];
  fileName?: string;
  fileSize?: number;
  createdAt?: string;
  jobs: JobView[];
}
