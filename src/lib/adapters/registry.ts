import type { PlatformAdapter } from "@/lib/platform-adapter";
import { platformSchema, type Platform } from "@/lib/platform";
import { DryRunAdapter } from "@/lib/adapters/dry-run-adapter";
import { YouTubeAdapter } from "@/lib/adapters/youtube-adapter";

// Keyed by Platform, not string: adding a platform to the shared union
// without also adding it here is a compile error, not a silent runtime gap.
const adapters: Record<Platform, PlatformAdapter> = {
  "dry-run": new DryRunAdapter(),
  youtube: new YouTubeAdapter(),
};

// Accepts a bare string, not Platform, because its real callers (the job
// engine resolving a DB-stored Job.platform) haven't validated yet — this
// is where that validation actually happens, via the same schema everyone
// else uses.
export function getAdapter(platform: string): PlatformAdapter {
  const parsed = platformSchema.safeParse(platform);
  if (!parsed.success) {
    throw new Error(`no adapter registered for platform "${platform}"`);
  }
  return adapters[parsed.data];
}
