-- Null means inherit the Upload's shared hashtag set; existing Jobs backfill to null.
ALTER TABLE "Job" ADD COLUMN "hashtagsOverride" TEXT;
