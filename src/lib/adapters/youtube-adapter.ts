import { accessTokenForYouTube } from "@/lib/youtube-oauth";
import { openVideoFile, type OpenVideoFile, type VideoFile } from "@/lib/video-file";
import {
  AdapterFailure,
  type PlatformAdapter,
  type TransferTracker,
  type UploadMetadata,
  type UploadResult,
} from "@/lib/platform-adapter";

const RESUMABLE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

// Deliberately an internal constant, not operator-facing config: it exists
// to keep peak memory well under the deployed VM's 1GB while staying above
// the 256KB multiple YouTube's resumable protocol requires of non-final
// chunks. There is nothing an operator would gain by tuning it.
const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

function contentTypeFor(filePath: string): string {
  if (filePath.toLowerCase().endsWith(".webm")) return "video/webm";
  if (filePath.toLowerCase().endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

// A YouTube that is rate limiting or broken says nothing about whether the
// request itself was sound, so it is worth repeating; anything else is
// YouTube rejecting what we sent.
function isRetryableStatus(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

// A session YouTube no longer knows about. Not terminal, despite being a
// 4xx: the video is fine, only this session is gone, and the next attempt
// starts a new one.
const SESSION_GONE_STATUSES = new Set([404, 410]);

function failureForResponse(response: Response, action: string): AdapterFailure {
  const kind = isRetryableStatus(response) ? "retryable" : "terminal";
  return new AdapterFailure(`YouTube ${action} failed (${response.status})`, kind);
}

// YouTube answers a partial chunk with the range it actually stored, which
// can be short of what was sent. That answer is the source of truth for
// where the next chunk starts; the bytes we sent are only a fallback for a
// response that omits the header.
function confirmedOffset(response: Response, sentThrough: number): number {
  const end = response.headers.get("range")?.match(/bytes=0-(\d+)$/)?.[1];
  return end === undefined ? sentThrough : Number(end) + 1;
}

// What asking YouTube about an interrupted session can tell us. "Expired"
// and "unavailable" are deliberately distinct: a session YouTube has
// forgotten must be replaced, while a YouTube we simply could not reach
// says nothing about the session, so the persisted offset still stands.
type ResumeAnswer =
  | { kind: "offset"; offset: number }
  | { kind: "completed"; response: Response }
  | { kind: "expired" }
  | { kind: "unavailable" };

// What that answer means for this attempt: carry on with the session it
// already has, request a new one from byte zero, or nothing left to send.
type TransferPlan =
  | { kind: "continue"; session: { url: string; offset: number } }
  | { kind: "start-fresh" }
  | { kind: "completed"; response: Response };

async function videoUrlFrom(response: Response): Promise<UploadResult> {
  const result = await response.json().catch(() => null) as { id?: unknown } | null;
  if (typeof result?.id !== "string" || result.id.length === 0) {
    throw new AdapterFailure("YouTube did not return a published video ID", "retryable");
  }
  return { url: `https://www.youtube.com/watch?v=${encodeURIComponent(result.id)}` };
}

export interface YouTubeAdapterOptions {
  /** Overridable so tests can drive a multi-chunk transfer with a small file. */
  chunkSizeBytes?: number;
  openFile?: OpenVideoFile;
}

// YouTube's resumable protocol separates metadata from the video bytes and
// accepts those bytes a chunk at a time, each PUT naming its own byte range
// and being acknowledged with the offset YouTube has stored. The adapter
// follows that protocol as documented: the file is never held in memory
// whole, and every confirmed offset is persisted before the next chunk is
// sent, so an interrupted transfer leaves behind an honest record of how
// far it actually got.
export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = "youtube";
  private readonly chunkSizeBytes: number;
  private readonly openFile: OpenVideoFile;

  constructor(options: YouTubeAdapterOptions = {}) {
    this.chunkSizeBytes = options.chunkSizeBytes ?? CHUNK_SIZE_BYTES;
    this.openFile = options.openFile ?? openVideoFile;
  }

  private async startSession(token: string, metadata: UploadMetadata, contentType: string): Promise<string> {
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
    return sessionUrl;
  }

  // The protocol's own resume-query: a zero-length PUT whose Content-Range
  // names no bytes, only the total. It is what makes a resumed transfer
  // safe — YouTube's own count of what it holds, rather than our guess.
  private async resumeQuery(
    sessionUrl: string,
    total: number,
    contentType: string,
  ): Promise<ResumeAnswer> {
    let response: Response;
    try {
      response = await fetch(sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Range": `bytes */${total}`,
        },
        redirect: "manual",
      });
    } catch {
      return { kind: "unavailable" };
    }

    if (response.status === 308) {
      // No Range header at all means YouTube holds nothing yet, which is a
      // resume from zero on a session that is still perfectly good.
      return { kind: "offset", offset: confirmedOffset(response, 0) };
    }
    if (response.ok) return { kind: "completed", response };
    // 4xx is YouTube telling us this session is gone; 5xx and rate limits
    // are YouTube telling us nothing at all.
    return isRetryableStatus(response) ? { kind: "unavailable" } : { kind: "expired" };
  }

  private async transferChunks(
    file: VideoFile,
    sessionUrl: string,
    contentType: string,
    transfer: TransferTracker,
    startOffset: number,
  ): Promise<Response> {
    let offset = startOffset;
    while (offset < file.size) {
      const sentFrom = offset;
      const chunk = await file.read(offset, this.chunkSizeBytes);
      if (chunk.byteLength === 0) {
        throw new AdapterFailure("The uploaded video file changed size mid-upload", "terminal");
      }
      const end = offset + chunk.byteLength - 1;

      let response: Response;
      try {
        response = await fetch(sessionUrl, {
          method: "PUT",
          headers: {
            "Content-Type": contentType,
            "Content-Range": `bytes ${offset}-${end}/${file.size}`,
          },
          body: chunk,
          // 308 means "chunk stored, send the next one" in this protocol,
          // but it is also a redirect status: left to follow, fetch would
          // chase it instead of handing back the offset YouTube confirmed.
          redirect: "manual",
        });
      } catch {
        throw new AdapterFailure("YouTube video transfer failed", "retryable");
      }

      if (response.status === 308) {
        offset = confirmedOffset(response, end + 1);
        // A session that keeps confirming an offset it already had would
        // otherwise loop forever, outside the job engine's retry budget:
        // the loop's own progress is what bounds it, not the attempt count.
        if (offset <= sentFrom) {
          throw new AdapterFailure(
            "YouTube stopped accepting new bytes for this upload",
            "retryable",
          );
        }
        // Persisted before the next chunk is requested, so a crash in
        // between cannot lose an offset YouTube has already confirmed.
        await transfer.record(offset);
        continue;
      }
      // Reachable when a resume-query was unavailable and we trusted the
      // persisted offset against a session YouTube had already dropped.
      // Failing terminally here would kill a job whose next attempt would
      // simply start a new session and succeed.
      if (SESSION_GONE_STATUSES.has(response.status)) {
        throw new AdapterFailure(
          `YouTube no longer has this upload session (${response.status})`,
          "retryable",
        );
      }
      if (!response.ok) throw failureForResponse(response, "video transfer");
      await transfer.record(file.size);
      return response;
    }

    // Every byte was acknowledged but YouTube never returned the video
    // resource — retrying the session is the documented way forward.
    throw new AdapterFailure("YouTube did not confirm the completed upload", "retryable");
  }

  // Where this attempt picks up, once the previous one's leftovers have
  // been checked against YouTube itself.
  private async planFrom(
    transfer: TransferTracker,
    total: number,
    contentType: string,
  ): Promise<TransferPlan> {
    const previous = transfer.resumable;
    if (!previous) return { kind: "start-fresh" };

    const answer = await this.resumeQuery(previous.sessionUrl, total, contentType);
    if (answer.kind === "completed") return { kind: "completed", response: answer.response };
    if (answer.kind === "expired") {
      // The stale state goes now rather than when a new session happens to
      // be granted: if starting one fails, the next attempt should not
      // waste a resume-query on a session YouTube has already disowned.
      await transfer.forget();
      return { kind: "start-fresh" };
    }

    // YouTube's own count wins; the persisted offset stands in only when
    // YouTube could not be reached to give one.
    const offset = answer.kind === "offset" ? answer.offset : previous.bytesUploaded;
    await transfer.record(offset);
    return { kind: "continue", session: { url: previous.sessionUrl, offset } };
  }

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

    let file: VideoFile;
    try {
      file = await this.openFile(metadata.filePath);
    } catch {
      throw new AdapterFailure("The uploaded video file is no longer available", "terminal");
    }

    try {
      if (file.size === 0) {
        throw new AdapterFailure("The uploaded video file is empty", "terminal");
      }

      const plan = await this.planFrom(metadata.transfer, file.size, contentType);
      if (plan.kind === "completed") {
        // YouTube had the whole video already: a crash between its last
        // acknowledgement and this job recording a result. Re-sending would
        // publish the video twice.
        await metadata.transfer.record(file.size);
        return videoUrlFrom(plan.response);
      }

      let session = plan.kind === "continue" ? plan.session : null;
      if (!session) {
        const sessionUrl = await this.startSession(token, metadata, contentType);
        await metadata.transfer.begin(sessionUrl);
        session = { url: sessionUrl, offset: 0 };
      }

      const completed = await this.transferChunks(
        file,
        session.url,
        contentType,
        metadata.transfer,
        session.offset,
      );
      return videoUrlFrom(completed);
    } finally {
      await file.close().catch(() => {});
    }
  }
}
