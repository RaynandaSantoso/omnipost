import type {
  PlatformAdapter,
  UploadMetadata,
  UploadResult,
} from "@/lib/platform-adapter";

// The user-facing dry-run adapter exercises the upload-to-Job pipeline
// without contacting a publishing platform. Its result is a local reference,
// so a fresh installation can be verified before connecting real accounts.
export class DryRunAdapter implements PlatformAdapter {
  readonly platform = "dry-run";

  async upload(metadata: UploadMetadata): Promise<UploadResult> {
    return { url: `dry-run://${encodeURIComponent(metadata.title)}` };
  }
}
