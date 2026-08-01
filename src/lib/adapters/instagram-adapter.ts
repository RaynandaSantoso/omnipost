import {
  InstagramCredentialFailure,
  instagramPublishingCredentials,
} from "@/lib/instagram-oauth";
import { createPublicMediaUrl } from "@/lib/public-media";
import {
  AdapterFailure,
  type PlatformAdapter,
  type UploadMetadata,
  type UploadResult,
} from "@/lib/platform-adapter";

const GRAPH_BASE_URL = "https://graph.facebook.com/v23.0";
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613]);

type GraphResponse = {
  id?: unknown;
  status_code?: unknown;
  status?: unknown;
  error?: {
    code?: unknown;
    error_subcode?: unknown;
    is_transient?: unknown;
    message?: unknown;
  };
};

function captionFor(metadata: UploadMetadata): string {
  return [metadata.title, metadata.description].filter(Boolean).join("\n");
}

async function responseBody(response: Response): Promise<GraphResponse | null> {
  return response.json().catch(() => null) as Promise<GraphResponse | null>;
}

function failureForResponse(
  response: Response,
  action: string,
  body: GraphResponse | null,
): AdapterFailure {
  const code = typeof body?.error?.code === "number" ? body.error.code : undefined;
  const retryable =
    response.status === 429 ||
    response.status >= 500 ||
    body?.error?.is_transient === true ||
    (code !== undefined && RATE_LIMIT_ERROR_CODES.has(code));
  const authenticationFailure = response.status === 401 || code === 102 || code === 190;
  const details = [
    `HTTP ${response.status}`,
    code === undefined ? null : `code ${code}`,
    typeof body?.error?.message === "string" ? body.error.message : null,
  ].filter(Boolean).join(", ");
  if (authenticationFailure) {
    return new AdapterFailure(
      `Instagram connection needs reconnecting (Meta rejected authentication: ${details})`,
      "terminal",
    );
  }
  return new AdapterFailure(
    `Instagram ${action} failed (${details})`,
    retryable ? "retryable" : "terminal",
  );
}

async function graphRequest(
  url: string,
  action: string,
  init?: RequestInit,
): Promise<GraphResponse> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new AdapterFailure(`Instagram ${action} could not reach Meta`, "retryable");
  }
  const body = await responseBody(response);
  if (!response.ok || body?.error) throw failureForResponse(response, action, body);
  return body ?? {};
}

function requiredId(body: GraphResponse, action: string): string {
  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new AdapterFailure(`Instagram did not return a ${action} reference`, "retryable");
  }
  return body.id;
}

export interface InstagramAdapterOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  maxStatusChecks?: number;
}

// Meta fetches the video itself, so this adapter gives it a short-lived
// capability URL, waits for that remote fetch/processing to finish, and only
// then publishes the prepared Reel. The job engine sees one ordinary upload.
export class InstagramAdapter implements PlatformAdapter {
  readonly platform = "instagram";
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxStatusChecks: number;

  constructor(options: InstagramAdapterOptions = {}) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxStatusChecks = options.maxStatusChecks ?? 60;
  }

  private async waitUntilReady(containerId: string, token: string): Promise<void> {
    for (let check = 0; check < this.maxStatusChecks; check += 1) {
      const url = new URL(`${GRAPH_BASE_URL}/${encodeURIComponent(containerId)}`);
      url.searchParams.set("fields", "status_code,status");
      url.searchParams.set("access_token", token);
      const body = await graphRequest(url.toString(), "media processing status");
      if (body.status_code === "FINISHED") return;
      if (body.status_code === "ERROR" || body.status_code === "EXPIRED") {
        const detail = typeof body.status === "string" ? `: ${body.status}` : "";
        throw new AdapterFailure(
          `Instagram rejected or could not fetch the video${detail}`,
          "terminal",
        );
      }
      if (body.status_code !== "IN_PROGRESS") {
        throw new AdapterFailure("Instagram returned an unknown media processing status", "terminal");
      }
      if (check + 1 < this.maxStatusChecks) await this.sleep(5_000);
    }
    throw new AdapterFailure(
      "Instagram timed out while fetching or processing the video; check that the public media URL is reachable",
      "terminal",
    );
  }

  async upload(metadata: UploadMetadata): Promise<UploadResult> {
    let token: string;
    let accountId: string;
    try {
      const credentials = await instagramPublishingCredentials(metadata.userId);
      token = credentials.accessToken;
      accountId = credentials.accountId;
    } catch (error) {
      if (error instanceof InstagramCredentialFailure && error.kind === "retryable") {
        throw new AdapterFailure(error.message, "retryable");
      }
      throw new AdapterFailure("Instagram connection needs reconnecting", "terminal");
    }

    let videoUrl: string;
    try {
      if (!metadata.uploadId) throw new Error("missing upload identity");
      videoUrl = createPublicMediaUrl(metadata.uploadId).toString();
    } catch {
      throw new AdapterFailure(
        "Instagram needs a configured public media URL before it can publish",
        "terminal",
      );
    }

    const createBody = new URLSearchParams({
      media_type: "REELS",
      video_url: videoUrl,
      caption: captionFor(metadata),
      access_token: token,
    });
    const container = await graphRequest(
      `${GRAPH_BASE_URL}/${encodeURIComponent(accountId)}/media`,
      "media container creation",
      { method: "POST", body: createBody },
    );
    const containerId = requiredId(container, "media container");
    await this.waitUntilReady(containerId, token);

    const publishBody = new URLSearchParams({
      creation_id: containerId,
      access_token: token,
    });
    const published = await graphRequest(
      `${GRAPH_BASE_URL}/${encodeURIComponent(accountId)}/media_publish`,
      "Reel publishing",
      { method: "POST", body: publishBody },
    );
    const mediaId = requiredId(published, "published media");
    return { url: `instagram://media/${encodeURIComponent(mediaId)}` };
  }
}
