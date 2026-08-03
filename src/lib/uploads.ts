import { prisma } from "@/lib/db";
import { saveUploadFile } from "@/lib/storage";
import { platformSchema, type Platform } from "@/lib/platform";
import {
  platformTextOverrideViolation,
  uploadPolicyViolation,
  type PlatformTextOverride,
  type PlatformTextOverrides,
} from "@/lib/platform-upload-policy";

export class UploadValidationError extends Error {}

function validateVideoFile(file: File, platforms: Platform[]): void {
  const violation = uploadPolicyViolation(file, platforms);
  if (violation) throw new UploadValidationError(violation);
}

// A fresh self-hosted installation stays safely verifiable with dry-run.
// Once its owner connects a platform, every connected platform receives an
// independent Job for the same Upload.
async function selectedPlatforms(userId: string): Promise<Platform[]> {
  const connections = await prisma.platformConnection.findMany({
    where: { userId },
    select: { platform: true },
  });
  const platforms = connections.flatMap((connection) => {
    const parsed = platformSchema.safeParse(connection.platform);
    return parsed.success ? [parsed.data] : [];
  });
  return platforms.length > 0 ? platforms : ["dry-run"];
}

export async function createUpload(params: {
  userId: string;
  title: string;
  description: string;
  file: File;
  platform?: Platform;
  overrides?: PlatformTextOverrides;
  hashtags?: string[];
}) {
  const { userId, title, description, file, hashtags = [] } = params;
  // An explicit platform overrides auto-selection outright, including
  // "youtube" with no connection — that isn't a privilege escalation (this
  // app is single-tenant, and the resulting job just fails terminally with
  // a clear "needs reconnecting" error, same as any other disconnect).
  const platforms = params.platform ? [params.platform] : await selectedPlatforms(userId);
  const overrides = params.overrides ?? {};
  for (const [platform, override] of Object.entries(overrides) as [Platform, PlatformTextOverride][]) {
    if (!platforms.includes(platform)) {
      throw new UploadValidationError(
        `metadata override target "${platform}" is not included in this upload`,
      );
    }
    const metadataViolation = platformTextOverrideViolation(platform, override);
    if (metadataViolation) throw new UploadValidationError(metadataViolation);
  }
  validateVideoFile(file, platforms);
  const { filePath, fileName, fileSize } = await saveUploadFile(file);

  return prisma.upload.create({
    data: {
      userId,
      title,
      description,
      hashtags: JSON.stringify(hashtags),
      fileName,
      filePath,
      fileSize,
      jobs: {
        create: platforms.map((platform) => ({
          platform,
          status: "pending",
          titleOverride: overrides[platform]?.title ?? null,
          descriptionOverride: overrides[platform]?.description ?? null,
          hashtagsOverride: overrides[platform]?.hashtags !== undefined
            ? JSON.stringify(overrides[platform].hashtags)
            : null,
        })),
      },
    },
    include: { jobs: true },
  });
}
