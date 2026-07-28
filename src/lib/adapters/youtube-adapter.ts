import { readFile } from "node:fs/promises";
import { accessTokenForYouTube } from "@/lib/youtube-oauth";
import {
  AdapterFailure,
  type PlatformAdapter,
  type UploadMetadata,
  type UploadResult,
} from "@/lib/platform-adapter";

const RESUMABLE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

function contentTypeFor(filePath: string): string {
  if (filePath.toLowerCase().endsWith(".webm")) return "video/webm";
  if (filePath.toLowerCase().endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

function failureForResponse(response: Response, action: string): AdapterFailure {
  const kind = response.status === 429 || response.status >= 500
    ? "retryable"
    : "terminal";
  return new AdapterFailure(`YouTube ${action} failed (${response.status})`, kind);
}

// YouTube's resumable protocol separates metadata from the video bytes,
// which lets Google resume the actual file transfer after a disruption.
export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = "youtube";

  async upload(metadata: UploadMetadata): Promise<UploadResult> {
    let token: string;
    try {
      token = await accessTokenForYouTube(metadata.userId);
    } catch {
      // A disconnected account or rejected refresh token cannot succeed on
      // another attempt; the operator must reconnect it before retrying.
      throw new AdapterFailure("YouTube connection needs reconnecting", "terminal");
    }
    const contentType = contentTypeFor(metadata.filePath);
    let start: Response;
    try {
      start = await fetch(`${RESUMABLE_UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": contentType,
        },
        body: JSON.stringify({
          snippet: { title: metadata.title, description: metadata.description },
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
        }),
      });
    } catch {
      throw new AdapterFailure("YouTube upload could not be started", "retryable");
    }
    if (!start.ok) throw failureForResponse(start, "upload start");

    const sessionUrl = start.headers.get("location");
    if (!sessionUrl) {
      throw new AdapterFailure("YouTube did not create an upload session", "retryable");
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(metadata.filePath);
    } catch {
      throw new AdapterFailure("The uploaded video file is no longer available", "terminal");
    }

    let uploaded: Response;
    try {
      uploaded = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(bytes).buffer,
      });
    } catch {
      throw new AdapterFailure("YouTube video transfer failed", "retryable");
    }
    if (!uploaded.ok) throw failureForResponse(uploaded, "video transfer");

    const result = await uploaded.json().catch(() => null) as { id?: unknown } | null;
    if (typeof result?.id !== "string" || result.id.length === 0) {
      throw new AdapterFailure("YouTube did not return a published video ID", "retryable");
    }
    return { url: `https://www.youtube.com/watch?v=${encodeURIComponent(result.id)}` };
  }
}
