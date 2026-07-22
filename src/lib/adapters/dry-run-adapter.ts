import type {
  PlatformAdapter,
  UploadMetadata,
  UploadResult,
} from "@/lib/platform-adapter";

// The user-facing dry-run feature (story 25), not a test double: it
// exercises the entire pipeline end to end with no outbound call to any
// platform, so a fresh install can be verified in one step before anything
// real is at risk. It also validates the adapter boundary itself, ahead of
// a second (YouTube) implementation being built against it.
export class DryRunAdapter implements PlatformAdapter {
  readonly platform = "dry-run";

  async upload(metadata: UploadMetadata): Promise<UploadResult> {
    return { url: `dry-run://${encodeURIComponent(metadata.title)}` };
  }
}
