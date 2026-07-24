import { prisma } from "@/lib/db";
import { saveUploadFile } from "@/lib/storage";

// A fresh self-hosted installation stays safely verifiable with dry-run.
// Once its single owner has connected YouTube, new uploads use the real
// adapter and therefore publish through that owner’s credentials.
async function selectedPlatform(userId: string): Promise<"dry-run" | "youtube"> {
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
}) {
  const { userId, title, description, file } = params;
  const { filePath, fileName, fileSize } = await saveUploadFile(file);
  const platform = await selectedPlatform(userId);

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
