import { prisma } from "@/lib/db";
import { saveUploadFile } from "@/lib/storage";
import { platformSchema, type Platform } from "@/lib/platform";

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
}) {
  const { userId, title, description, file } = params;
  const { filePath, fileName, fileSize } = await saveUploadFile(file);
  // An explicit platform overrides auto-selection outright, including
  // "youtube" with no connection — that isn't a privilege escalation (this
  // app is single-tenant, and the resulting job just fails terminally with
  // a clear "needs reconnecting" error, same as any other disconnect).
  const platforms = params.platform ? [params.platform] : await selectedPlatforms(userId);

  return prisma.upload.create({
    data: {
      userId,
      title,
      description,
      fileName,
      filePath,
      fileSize,
      jobs: {
        create: platforms.map((platform) => ({ platform, status: "pending" })),
      },
    },
    include: { jobs: true },
  });
}
