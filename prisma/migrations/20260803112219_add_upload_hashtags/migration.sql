-- Existing Uploads backfill to "[]" (no hashtags) via the column default.
ALTER TABLE "Upload" ADD COLUMN "hashtags" TEXT NOT NULL DEFAULT '[]';
