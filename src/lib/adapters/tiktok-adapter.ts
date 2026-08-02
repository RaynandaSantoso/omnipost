import { readFile, stat } from "node:fs/promises";
import { accessTokenForTikTok } from "@/lib/tiktok-oauth";
import {
  AdapterFailure,
  type PlatformAdapter,
  type UploadMetadata,
  type UploadResult,
} from "@/lib/platform-adapter";
import { composeCaption, uploadPolicyFor } from "@/lib/platform-upload-policy";

const VIDEO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const SELF_ONLY_PRIVACY = "SELF_ONLY";
const MAX_SINGLE_CHUNK_BYTES = uploadPolicyFor("tiktok").maxFileSizeBytes!;
const RETRYABLE_ERROR_CODES = new Set(["internal_error", "rate_limit_exceeded"]);
const RETRYABLE_PUBLISH_FAILURES = new Set(["internal", "video_pull_failed", "photo_pull_failed"]);

function contentTypeFor(filePath: string): string {
  if (filePath.toLowerCase().endsWith(".webm")) return "video/webm";
  if (filePath.toLowerCase().endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

function failureForResponse(
  response: Response,
  action: string,
  errorCode?: string,
): AdapterFailure {
  const kind =
    response.status === 429 ||
    response.status >= 500 ||
    (errorCode !== undefined && RETRYABLE_ERROR_CODES.has(errorCode))
      ? "retryable"
      : "terminal";
  const detail = errorCode ? `${errorCode}, HTTP ${response.status}` : `HTTP ${response.status}`;
  return new AdapterFailure(`TikTok ${action} failed (${detail})`, kind);
}

type InitResponse = {
  data?: { publish_id?: unknown; upload_url?: unknown };
  error?: { code?: unknown; message?: unknown };
};

type StatusResponse = {
  data?: { status?: unknown; fail_reason?: unknown };
  error?: { code?: unknown; message?: unknown };
};

export interface TikTokAdapterOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  maxStatusChecks?: number;
}

// TikTok's Direct Post API first creates a publishing session, then accepts
// the video at the temporary upload URL it returns. The adapter keeps that
// protocol detail below the common PlatformAdapter boundary.
export class TikTokAdapter implements PlatformAdapter {
  readonly platform = "tiktok";
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxStatusChecks: number;

  constructor(options: TikTokAdapterOptions = {}) {
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxStatusChecks = options.maxStatusChecks ?? 30;
  }

  private async waitForPublish(token: string, publishId: string): Promise<void> {
    for (let check = 0; check < this.maxStatusChecks; check += 1) {
      let response: Response;
      try {
        response = await fetch(STATUS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=UTF-8",
          },
          body: JSON.stringify({ publish_id: publishId }),
        });
      } catch {
        if (check + 1 < this.maxStatusChecks) {
          await this.sleep(2_000);
          continue;
        }
        throw new AdapterFailure(
          `TikTok status for ${publishId} could not be confirmed; check TikTok before retrying`,
          "terminal",
        );
      }

      const body = await response.json().catch(() => null) as StatusResponse | null;
      const errorCode =
        typeof body?.error?.code === "string" ? body.error.code : undefined;
      if (!response.ok || (errorCode !== undefined && errorCode !== "ok")) {
        const failure = failureForResponse(response, "post status", errorCode);
        if (failure.kind === "retryable") {
          if (check + 1 < this.maxStatusChecks) {
            await this.sleep(2_000);
            continue;
          }
          throw new AdapterFailure(
            `TikTok status for ${publishId} could not be confirmed; check TikTok before retrying`,
            "terminal",
          );
        }
        throw failure;
      }

      const status = body?.data?.status;
      if (status === "PUBLISH_COMPLETE") return;
      if (status === "FAILED") {
        const reason =
          typeof body?.data?.fail_reason === "string"
            ? body.data.fail_reason
            : "unknown_failure";
        const kind = RETRYABLE_PUBLISH_FAILURES.has(reason) ? "retryable" : "terminal";
        throw new AdapterFailure(`TikTok post failed (${reason})`, kind);
      }
      if (status !== "PROCESSING_UPLOAD" && status !== "PROCESSING_DOWNLOAD") {
        throw new AdapterFailure("TikTok returned an unknown post status", "terminal");
      }
      if (check + 1 < this.maxStatusChecks) await this.sleep(2_000);
    }

    // Do not automatically start a second Direct Post when TikTok may still
    // finish this one: surface the publish reference for manual follow-up.
    throw new AdapterFailure(
      `TikTok is still processing ${publishId}; check TikTok before retrying`,
      "terminal",
    );
  }

  async upload(metadata: UploadMetadata): Promise<UploadResult> {
    let token: string;
    try {
      token = await accessTokenForTikTok(metadata.userId);
    } catch {
      throw new AdapterFailure("TikTok connection needs reconnecting", "terminal");
    }

    let fileSize: number;
    try {
      fileSize = (await stat(metadata.filePath)).size;
    } catch {
      throw new AdapterFailure("The uploaded video file is no longer available", "terminal");
    }
    if (fileSize > MAX_SINGLE_CHUNK_BYTES) {
      throw new AdapterFailure(
        "TikTok videos larger than 64 MB require chunked upload, which is not supported yet",
        "terminal",
      );
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(metadata.filePath);
    } catch {
      throw new AdapterFailure("The uploaded video file is no longer available", "terminal");
    }
    const contentType = contentTypeFor(metadata.filePath);

    let initialized: Response;
    try {
      initialized = await fetch(VIDEO_INIT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({
          post_info: {
            title: composeCaption(metadata),
            privacy_level: SELF_ONLY_PRIVACY,
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
          },
          source_info: {
            source: "FILE_UPLOAD",
            video_size: bytes.length,
            chunk_size: bytes.length,
            total_chunk_count: 1,
          },
        }),
      });
    } catch {
      throw new AdapterFailure("TikTok upload could not be started", "retryable");
    }
    const session = await initialized.json().catch(() => null) as InitResponse | null;
    const errorCode =
      typeof session?.error?.code === "string" ? session.error.code : undefined;
    if (!initialized.ok || (errorCode !== undefined && errorCode !== "ok")) {
      throw failureForResponse(initialized, "upload start", errorCode);
    }
    const publishId = session?.data?.publish_id;
    const uploadUrl = session?.data?.upload_url;
    if (typeof publishId !== "string" || typeof uploadUrl !== "string" || !uploadUrl) {
      throw new AdapterFailure("TikTok did not create an upload session", "retryable");
    }

    let transferred: Response;
    try {
      transferred = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(bytes.length),
          "Content-Range": `bytes 0-${Math.max(bytes.length - 1, 0)}/${bytes.length}`,
        },
        body: new Uint8Array(bytes).buffer,
      });
    } catch {
      throw new AdapterFailure("TikTok video transfer failed", "retryable");
    }
    if (!transferred.ok) throw failureForResponse(transferred, "video transfer");

    await this.waitForPublish(token, publishId);

    // TikTok does not return a public video URL for SELF_ONLY posts. The
    // publish id is still a stable completion reference for the job history.
    return { url: `tiktok://publish/${encodeURIComponent(publishId)}` };
  }
}
