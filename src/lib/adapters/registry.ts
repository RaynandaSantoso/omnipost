import type { PlatformAdapter } from "@/lib/platform-adapter";
import { platformSchema, type Platform } from "@/lib/platform";
import { DryRunAdapter } from "@/lib/adapters/dry-run-adapter";
import { YouTubeAdapter } from "@/lib/adapters/youtube-adapter";
import { TikTokAdapter } from "@/lib/adapters/tiktok-adapter";

// A platform may become connectable one ticket before its publishing adapter
// lands. The explicit partial registry lets fan-out exclude that platform
// until the adapter is present instead of creating an unserviceable Job.
const adapters: Partial<Record<Platform, PlatformAdapter>> = {
  "dry-run": new DryRunAdapter(),
  youtube: new YouTubeAdapter(),
  tiktok: new TikTokAdapter(),
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
  const adapter = adapters[parsed.data];
  if (!adapter) {
    throw new Error(`no adapter registered for platform "${platform}"`);
  }
  return adapter;
}

export function hasRegisteredAdapter(platform: Platform): boolean {
  return Boolean(adapters[platform]);
}
