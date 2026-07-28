import type { Platform } from "@/lib/platform";

// Contract every platform integration implements. The job engine depends
// only on this — nothing about the pipeline (schema, endpoints, runner)
// knows YouTube, TikTok, or Instagram exist.

export type AdapterFailureKind = "retryable" | "terminal";

// Thrown by an adapter's upload() to report a failure the job engine can
// act on. The kind distinguishes "try again later" (rate limit, 5xx,
// network) from "give up and wait for the user" (bad credentials, rejected
// content) — retry/backoff policy itself lives in the job engine, not here.
export class AdapterFailure extends Error {
  readonly kind: AdapterFailureKind;

  constructor(message: string, kind: AdapterFailureKind) {
    super(message);
    this.name = "AdapterFailure";
    this.kind = kind;
  }
}

export interface UploadMetadata {
  userId: string;
  title: string;
  description: string;
  filePath: string;
}

export interface UploadResult {
  url: string;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  upload(metadata: UploadMetadata): Promise<UploadResult>;
}
