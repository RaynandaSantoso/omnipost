import { prisma } from "@/lib/db";
import { saveUploadFile } from "@/lib/storage";

// v0.1 always fans out to a single dry-run Job. Real platform selection
// (driven by which PlatformConnections exist) arrives with YouTube OAuth.
const DEFAULT_PLATFORM = "dry-run";

export async function createUpload(params: {
  userId: string;
  title: string;
  description: string;
  file: File;
}) {
  const { userId, title, description, file } = params;
  const { filePath, fileName, fileSize } = await saveUploadFile(file);

  return prisma.upload.create({
    data: {
      userId,
      title,
      description,
      fileName,
      filePath,
      fileSize,
      jobs: {
        create: [{ platform: DEFAULT_PLATFORM, status: "pending" }],
      },
    },
    include: { jobs: true },
  });
}
