-- RenameColumn: PlatformConnection.channelId -> externalAccountId (data preserved)
ALTER TABLE "PlatformConnection" RENAME COLUMN "channelId" TO "externalAccountId";

-- AddColumn
ALTER TABLE "PlatformConnection" ADD COLUMN "externalAccountLabel" TEXT;
