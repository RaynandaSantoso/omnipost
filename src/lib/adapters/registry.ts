import type { PlatformAdapter } from "@/lib/platform-adapter";
import { DryRunAdapter } from "@/lib/adapters/dry-run-adapter";

const adapters: Record<string, PlatformAdapter> = {
  "dry-run": new DryRunAdapter(),
};

export function getAdapter(platform: string): PlatformAdapter {
  const adapter = adapters[platform];
  if (!adapter) {
    throw new Error(`no adapter registered for platform "${platform}"`);
  }
  return adapter;
}
