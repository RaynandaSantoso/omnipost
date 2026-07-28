import { z } from "zod";

// Single source of truth for what a valid platform value is. TikTok and
// Instagram each add one line here when their own PRDs land — nothing else
// about this module changes.
export const platformSchema = z.enum(["dry-run", "youtube"]);

export type Platform = z.infer<typeof platformSchema>;
