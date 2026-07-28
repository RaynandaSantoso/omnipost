import { prisma } from "@/lib/db";
import { saveUploadFile } from "@/lib/storage";
import type { Platform } from "@/lib/platform";

// A fresh self-hosted installation stays safely verifiable with dry-run.
// Once its single owner has connected YouTube, new uploads use the real
// adapter and therefore publish through that owner’s credentials.
async function selectedPlatform(userId: string): Promise<Platform> {
  const connection = await prisma.platformConnection.findUnique({
    where: { userId_platform: { userId, platform: "youtube" } },
    select: { id: true },
  });
  return connection ? "youtube" : "dry-run";
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
  const platform = params.platform ?? (await selectedPlatform(userId));

  return prisma.upload.create({
    data: {
      userId,
      title,
      description,
      fileName,
      filePath,
      fileSize,
      jobs: {
        create: [{ platform, status: "pending" }],
      },
    },
    include: { jobs: true },
  });
}
