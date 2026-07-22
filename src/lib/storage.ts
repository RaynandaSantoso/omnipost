import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDatabaseUrl } from "@/lib/database-url";

// Uploaded video files live next to the SQLite database, inside the same
// mounted data volume — so they survive a restart the same way the
// database does, with no extra volume or env var to configure.
function uploadsDir(): string {
  const dbPath = resolveDatabaseUrl(
    process.env.DATABASE_URL ?? "file:./data/dev.db",
  ).replace(/^file:/, "");
  const base = dbPath === ":memory:" ? process.cwd() : path.dirname(dbPath);
  return path.join(base, "uploads");
}

export async function saveUploadFile(
  file: File,
): Promise<{ filePath: string; fileName: string; fileSize: number }> {
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  const filePath = path.join(dir, `${randomUUID()}${path.extname(file.name)}`);
  fs.writeFileSync(filePath, buffer);

  return { filePath, fileName: file.name, fileSize: buffer.length };
}
