import type { Platform } from "@/lib/platform";

interface PlatformUploadPolicy {
  maxFileSizeBytes?: number;
  oversizeMessage?: string;
  requireMatchingVideoExtension?: boolean;
}

const PLATFORM_UPLOAD_POLICIES = {
  "dry-run": {},
  youtube: {},
  instagram: {},
  tiktok: {
    maxFileSizeBytes: 64 * 1024 * 1024,
    oversizeMessage: "TikTok whole-file uploads must be 64 MB or smaller",
    requireMatchingVideoExtension: true,
  },
} satisfies Record<Platform, PlatformUploadPolicy>;

const VIDEO_TYPE_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function uploadPolicyFor(platform: Platform): PlatformUploadPolicy {
  return PLATFORM_UPLOAD_POLICIES[platform];
}

export function uploadPolicyViolation(
  file: Pick<File, "name" | "size" | "type">,
  platforms: Platform[],
): string | null {
  for (const platform of platforms) {
    const policy = uploadPolicyFor(platform);
    if (policy.requireMatchingVideoExtension) {
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      const expectedType = VIDEO_TYPE_BY_EXTENSION[extension];
      if (!expectedType) return "Use an MP4, WebM, or MOV video file";
      if (file.type && file.type !== expectedType) {
        return `The video MIME type ${file.type} does not match the .${extension} filename`;
      }
    }
    if (
      policy.maxFileSizeBytes !== undefined &&
      file.size > policy.maxFileSizeBytes
    ) {
      return policy.oversizeMessage ?? "The video is too large for this platform";
    }
  }
  return null;
}
