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

// Where an adapter persists the state of the transfer it is running, so a
// confirmed byte offset survives a crash between chunks and the dashboard
// can report real platform-side progress. The adapter knows its platform's
// resumable protocol; it does not know these end up as columns on a Job.
export interface TransferTracker {
  /** A fresh platform session: its URL replaces any earlier one, from byte zero. */
  begin(sessionUrl: string): Promise<void>;
  /** The platform has confirmed receiving this many bytes of the video. */
  record(bytesUploaded: number): Promise<void>;
}

// A real tracker that keeps nothing, for callers with no durable place to
// put transfer state. An adapter cannot tell the difference, which is the
// point: reporting progress is never conditional on someone listening.
export const UNTRACKED_TRANSFER: TransferTracker = {
  begin: async () => {},
  record: async () => {},
};

export interface UploadMetadata {
  userId: string;
  title: string;
  description: string;
  filePath: string;
  transfer: TransferTracker;
}

export interface UploadResult {
  url: string;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  upload(metadata: UploadMetadata): Promise<UploadResult>;
}
