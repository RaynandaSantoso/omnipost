import { readFile } from "node:fs/promises";
import { accessTokenForTikTok } from "@/lib/tiktok-oauth";
import {
  AdapterFailure,
  type PlatformAdapter,
  type UploadMetadata,
  type UploadResult,
} from "@/lib/platform-adapter";

const VIDEO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const SELF_ONLY_PRIVACY = "SELF_ONLY";

function failureForResponse(response: Response, action: string): AdapterFailure {
  const kind = response.status === 429 || response.status >= 500 ? "retryable" : "terminal";
  return new AdapterFailure(`TikTok ${action} failed (${response.status})`, kind);
}

type InitResponse = {
  data?: { publish_id?: unknown; upload_url?: unknown };
};

// TikTok's Direct Post API first creates a publishing session, then accepts
// the video at the temporary upload URL it returns. The adapter keeps that
// protocol detail below the common PlatformAdapter boundary.
export class TikTokAdapter implements PlatformAdapter {
  readonly platform = "tiktok";

  async upload(metadata: UploadMetadata): Promise<UploadResult> {
    let token: string;
    try {
      token = await accessTokenForTikTok(metadata.userId);
    } catch {
      throw new AdapterFailure("TikTok connection needs reconnecting", "terminal");
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(metadata.filePath);
    } catch {
      throw new AdapterFailure("The uploaded video file is no longer available", "terminal");
    }

    let initialized: Response;
    try {
      initialized = await fetch(VIDEO_INIT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          post_info: {
            title: [metadata.title, metadata.description].filter(Boolean).join("\n"),
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
    if (!initialized.ok) throw failureForResponse(initialized, "upload start");

    const session = await initialized.json().catch(() => null) as InitResponse | null;
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
          "Content-Type": "video/mp4",
          "Content-Range": `bytes 0-${Math.max(bytes.length - 1, 0)}/${bytes.length}`,
        },
        body: new Uint8Array(bytes).buffer,
      });
    } catch {
      throw new AdapterFailure("TikTok video transfer failed", "retryable");
    }
    if (!transferred.ok) throw failureForResponse(transferred, "video transfer");

    // TikTok does not return a public video URL for SELF_ONLY posts. The
    // publish id is still a stable completion reference for the job history.
    return { url: `tiktok://publish/${encodeURIComponent(publishId)}` };
  }
}
