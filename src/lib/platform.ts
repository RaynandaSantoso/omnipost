import { z } from "zod";

// Single source of truth for valid platform values. Adding a destination
// extends this union; provider behavior belongs in its adapter and OAuth flow.
export const platformSchema = z.enum(["dry-run", "youtube", "tiktok", "instagram"]);

export type Platform = z.infer<typeof platformSchema>;

// How each Platform is named to the operator, in one place so the connect
// block, the job status text, and the per-platform editors can't drift apart.
// "dry-run" publishes nowhere, so it stands in for whatever platform would
// have received the video.
export const PLATFORM_LABEL: Record<Platform, string> = {
  "dry-run": "The platform",
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
};
