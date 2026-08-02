-- Existing Jobs inherit their Upload metadata because both new columns are
-- nullable and therefore backfill safely to NULL.
ALTER TABLE "Job" ADD COLUMN "titleOverride" TEXT;
ALTER TABLE "Job" ADD COLUMN "descriptionOverride" TEXT;
