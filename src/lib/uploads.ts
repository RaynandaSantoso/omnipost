import { prisma } from "@/lib/db";
import { jobMetadataViolation } from "@/lib/job-metadata";
import { saveUploadFile } from "@/lib/storage";
import { platformSchema, type Platform } from "@/lib/platform";
import {
  platformTextOverrideViolation,
  uploadPolicyViolation,
  type PlatformTextOverride,
  type PlatformTextOverrides,
} from "@/lib/platform-upload-policy";

export class UploadValidationError extends Error {}

// One Job row, exactly as it will be written. Validation reads the same shape,
// so the text that gets measured is the text that gets stored.
function jobRowFor(platform: Platform, override: PlatformTextOverride | undefined) {
  return {
    platform,
    titleOverride: override?.title ?? null,
    descriptionOverride: override?.description ?? null,
    hashtagsOverride: override?.hashtags !== undefined
      ? JSON.stringify(override.hashtags)
      : null,
  };
}

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

async function requestedPlatforms(userId: string, platforms: Platform[]): Promise<Platform[]> {
  if (platforms.length === 0) {
    throw new UploadValidationError("select at least one platform before uploading");
  }

  const connected = await selectedPlatforms(userId);
  for (const platform of platforms) {
    if (platform === "dry-run") {
      throw new UploadValidationError("platform \"dry-run\" is not connected");
    }
    if (!connected.includes(platform)) {
      throw new UploadValidationError(`platform "${platform}" is not connected`);
    }
  }
  return platforms;
}

export async function createUpload(params: {
  userId: string;
  title: string;
  description: string;
  file: File;
  platforms?: Platform[];
  overrides?: PlatformTextOverrides;
  hashtags?: string[];
}) {
  const { userId, title, description, file, hashtags = [] } = params;
  const platforms = params.platforms
    ? await requestedPlatforms(userId, params.platforms)
    : await selectedPlatforms(userId);
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
  // Every target platform, not only the overridden ones: a caption can be
  // pushed past its limit entirely by the Upload's shared text and hashtag
  // set, with no override involved anywhere. One platform overflowing rejects
  // the whole Upload rather than quietly dropping that platform's Job — the
  // operator asked to publish everywhere, and shortening the hashtags is a
  // choice for them to make.
  for (const platform of platforms) {
    const composedViolation = jobMetadataViolation(
      jobRowFor(platform, overrides[platform]),
      { title, description, hashtags },
    );
    if (composedViolation) throw new UploadValidationError(composedViolation);
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
          ...jobRowFor(platform, overrides[platform]),
          status: "pending",
        })),
      },
    },
    include: { jobs: true },
  });
}
