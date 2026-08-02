import type { Platform } from "@/lib/platform";

export interface AuthoredText {
  title: string;
  description: string;
}

export interface PlatformTextOverride {
  title?: string;
  description?: string;
}

export type PlatformTextOverrides = Partial<Record<Platform, PlatformTextOverride>>;

export function platformTextOverrideViolation(
  platform: Platform,
  override: { title?: string | null; description?: string | null },
): string | null {
  const shape = uploadPolicyFor(platform).text;
  if (shape.kind === "caption") {
    if (override.description !== undefined && override.description !== null) {
      return `${platform} accepts one finished caption override, not a separate description`;
    }
    if (
      override.title !== undefined &&
      override.title !== null &&
      override.title.length > shape.captionMaxLength
    ) {
      return `${platform} caption must be ${shape.captionMaxLength} characters or fewer`;
    }
    return null;
  }
  if (
    override.title !== undefined &&
    override.title !== null &&
    shape.titleMaxLength !== null &&
    override.title.length > shape.titleMaxLength
  ) {
    return `${platform} title must be ${shape.titleMaxLength} characters or fewer`;
  }
  if (
    override.description !== undefined &&
    override.description !== null &&
    shape.descriptionMaxLength !== null &&
    override.description.length > shape.descriptionMaxLength
  ) {
    return `${platform} description must be ${shape.descriptionMaxLength} characters or fewer`;
  }
  return null;
}

interface TitleAndDescriptionTextShape {
  kind: "title-and-description";
  titleMaxLength: number | null;
  descriptionMaxLength: number | null;
}

interface CaptionTextShape {
  kind: "caption";
  captionMaxLength: number;
  compose: (authored: AuthoredText) => string;
}

export type PlatformTextShape =
  | TitleAndDescriptionTextShape
  | CaptionTextShape;

export interface OutboundTextField {
  key: "title" | "description" | "caption";
  label: "Title" | "Description" | "Caption";
  maxLength: number | null;
  value: string;
}

interface PlatformUploadPolicy {
  text: PlatformTextShape;
  maxFileSizeBytes?: number;
  oversizeMessage?: string;
  requireMatchingVideoExtension?: boolean;
  allowedVideoExtensions?: readonly string[];
  unsupportedFormatMessage?: string;
}

export function composeCaption({ title, description }: AuthoredText): string {
  return [title, description].filter(Boolean).join("\n");
}

const PLATFORM_UPLOAD_POLICIES = {
  "dry-run": {
    text: {
      kind: "title-and-description",
      titleMaxLength: null,
      descriptionMaxLength: null,
    },
  },
  youtube: {
    text: {
      kind: "title-and-description",
      titleMaxLength: 100,
      descriptionMaxLength: 5_000,
    },
  },
  instagram: {
    text: {
      kind: "caption",
      captionMaxLength: 2_200,
      compose: composeCaption,
    },
    allowedVideoExtensions: ["mp4", "mov"],
    maxFileSizeBytes: 1024 * 1024 * 1024,
    oversizeMessage: "Instagram Reels must be 1 GB or smaller",
    unsupportedFormatMessage: "Instagram Reels must use an MP4 or MOV video file",
    requireMatchingVideoExtension: true,
  },
  tiktok: {
    text: {
      kind: "caption",
      captionMaxLength: 2_200,
      compose: composeCaption,
    },
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

export function outboundTextFor(
  platform: Platform,
  authored: AuthoredText,
): OutboundTextField[] {
  const shape = uploadPolicyFor(platform).text;
  if (shape.kind === "caption") {
    return [{
      key: "caption",
      label: "Caption",
      maxLength: shape.captionMaxLength,
      value: shape.compose(authored),
    }];
  }
  return [
    {
      key: "title",
      label: "Title",
      maxLength: shape.titleMaxLength,
      value: authored.title,
    },
    {
      key: "description",
      label: "Description",
      maxLength: shape.descriptionMaxLength,
      value: authored.description,
    },
  ];
}

export function uploadPolicyViolation(
  file: Pick<File, "name" | "size" | "type">,
  platforms: Platform[],
): string | null {
  for (const platform of platforms) {
    const policy = uploadPolicyFor(platform);
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (
      policy.allowedVideoExtensions &&
      !policy.allowedVideoExtensions.includes(extension)
    ) {
      return policy.unsupportedFormatMessage ?? "The video format is not supported by this platform";
    }
    if (policy.requireMatchingVideoExtension) {
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
