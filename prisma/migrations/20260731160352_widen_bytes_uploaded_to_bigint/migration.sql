/*
  Warnings:

  - You are about to alter the column `bytesUploaded` on the `Job` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultUrl" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "uploadSessionUrl" TEXT,
    "bytesUploaded" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("attempts", "bytesUploaded", "createdAt", "error", "id", "leaseExpiresAt", "leaseOwner", "nextAttemptAt", "platform", "resultUrl", "status", "updatedAt", "uploadId", "uploadSessionUrl") SELECT "attempts", "bytesUploaded", "createdAt", "error", "id", "leaseExpiresAt", "leaseOwner", "nextAttemptAt", "platform", "resultUrl", "status", "updatedAt", "uploadId", "uploadSessionUrl" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_status_nextAttemptAt_idx" ON "Job"("status", "nextAttemptAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
