"use client";

import { useEffect, useRef, useState } from "react";
import type { Platform } from "@/lib/platform";
import {
  formatHashtags,
  outboundTextFor,
  uploadPolicyFor,
  uploadPolicyViolation,
  type AuthoredText,
  type PlatformTextOverride,
  type PlatformTextOverrides,
} from "@/lib/platform-upload-policy";
import { resolveJobMetadata } from "@/lib/job-metadata";

interface JobView {
  id: string;
  platform: Platform;
  status: "pending" | "uploading" | "done" | "failed";
  resultUrl: string | null;
  error: string | null;
  /** Bytes the platform has confirmed receiving, once a transfer is under way. */
  bytesUploaded?: number | null;
  titleOverride?: string | null;
  descriptionOverride?: string | null;
  hashtagsOverride?: string[] | null;
  metadataSource?: "shared" | "overridden";
  overrideSource?: "shared" | "overridden";
  effectiveMetadata?: AuthoredText;
  savedMetadata?: AuthoredText;
  metadataAppliesTo?: "next-attempt" | "future-attempt";
}

interface UploadView {
  id: string;
  title?: string;
  description?: string;
  hashtags?: string[];
  fileName?: string;
  fileSize?: number;
  createdAt?: string;
  jobs: JobView[];
}

interface YouTubeConnectionView {
  connected: boolean;
  externalAccountId: string | null;
  externalAccountLabel: string | null;
  reconnectNeeded: boolean;
}

type TikTokConnectionView = YouTubeConnectionView;
type InstagramConnectionView = YouTubeConnectionView;

const STATUS_LABEL: Record<JobView["status"], string> = {
  pending: "Pending",
  uploading: "Uploading",
  done: "Done",
  failed: "Failed",
};

const MAX_FILE_SIZE_BYTES = 256 * 1024 * 1024;
const MAX_DURATION_SECONDS = 180;
const SUPPORTED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

interface PlatformPresentation {
  name: string;
  linkResult: boolean;
  uploadingMessage?: string;
  successMessage?: (job: JobView) => string | null;
}

const PLATFORM_PRESENTATION: Record<Platform, PlatformPresentation> = {
  "dry-run": { name: "The platform", linkResult: true },
  youtube: { name: "YouTube", linkResult: true },
  tiktok: {
    name: "TikTok",
    linkResult: false,
    successMessage: () => "Posted privately to your TikTok account (SELF_ONLY).",
  },
  instagram: {
    name: "Instagram",
    linkResult: false,
    uploadingMessage: "Instagram is fetching and processing your Reel.",
    successMessage: (job) => {
      const prefix = "instagram://media/";
      if (!job.resultUrl?.startsWith(prefix)) return null;
      return `Published to Instagram (media ${decodeURIComponent(job.resultUrl.slice(prefix.length))}).`;
    },
  },
};

export function parseHashtagInput(raw: string): string[] {
  return raw.split(/[\s,]+/).map((tag) => tag.trim()).filter(Boolean);
}

function typeFor(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension === "mov" ? "video/quicktime" : `video/${extension ?? "unknown"}`;
}

function uploadTargetPlatforms(
  youtube: YouTubeConnectionView | null,
  tiktok: TikTokConnectionView | null,
  instagram: InstagramConnectionView | null,
): Platform[] {
  const connected: Platform[] = [
    ...(youtube?.connected ? ["youtube" as const] : []),
    ...(tiktok?.connected ? ["tiktok" as const] : []),
    ...(instagram?.connected ? ["instagram" as const] : []),
  ];
  return connected.length > 0 ? connected : ["dry-run"];
}

export function youtubeConnectionStatusText(youtube: YouTubeConnectionView | null): string {
  if (!youtube?.connected) return "Not connected";
  if (youtube.reconnectNeeded) return "Reconnect needed";
  return `Connected to ${youtube.externalAccountLabel ?? youtube.externalAccountId}`;
}

export function tiktokConnectionStatusText(tiktok: TikTokConnectionView | null): string {
  if (!tiktok?.connected) return "Not connected";
  if (tiktok.reconnectNeeded) return "Reconnect needed";
  return `Connected to ${tiktok.externalAccountLabel ?? tiktok.externalAccountId}`;
}

export function instagramConnectionStatusText(instagram: InstagramConnectionView | null): string {
  if (!instagram?.connected) return "Not connected";
  if (instagram.reconnectNeeded) return "Reconnect needed";
  const account = instagram.externalAccountLabel
    ? `@${instagram.externalAccountLabel.replace(/^@/, "")}`
    : instagram.externalAccountId;
  return `Connected to ${account}`;
}

// The share of the video the platform itself has taken, which is a
// different (and longer) leg than the browser-to-server upload the form's
// own progress bar tracks. Null whenever there is nothing honest to show.
export function transferPercent(job: JobView, fileSize?: number): number | null {
  if (job.status !== "uploading") return null;
  if (!fileSize || job.bytesUploaded == null) return null;
  return Math.min(100, Math.round((job.bytesUploaded / fileSize) * 100));
}

function readableFailure(job: JobView): string {
  const name = PLATFORM_PRESENTATION[job.platform].name;
  if (!job.error) return "";
  if (job.error.toLowerCase().includes("reconnect")) return `${name} needs to be reconnected before this upload can continue.`;
  if (job.error.toLowerCase().includes("credential")) return `${name} rejected the connected account credentials.`;
  if (job.error.includes("429")) return `${name} is rate limiting uploads. It will retry automatically.`;
  return job.error;
}

function successMessageFor(job: JobView): string | null {
  if (job.status !== "done") return null;
  return PLATFORM_PRESENTATION[job.platform].successMessage?.(job) ?? null;
}

export function JobOutcome({
  job,
  onRetry,
  history = false,
}: {
  job: JobView;
  onRetry: () => void;
  history?: boolean;
}) {
  const presentation = PLATFORM_PRESENTATION[job.platform];
  const successMessage = successMessageFor(job);
  return <>
    {job.status === "uploading" && presentation.uploadingMessage && (
      <span className="text-zinc-600 dark:text-zinc-400">
        {presentation.uploadingMessage}
      </span>
    )}
    {job.status === "done" && (
      <>
        {job.resultUrl && presentation.linkResult && (
          <a href={job.resultUrl} className="truncate text-blue-600 underline dark:text-blue-400">
            {history ? "View published video" : job.resultUrl}
          </a>
        )}
        {successMessage && <span className="text-green-700 dark:text-green-400">{successMessage}</span>}
      </>
    )}
    {job.status === "failed" && job.error && (
      <>
        <span className="text-red-600 dark:text-red-400">{readableFailure(job)}</span>
        <button type="button" onClick={onRetry} className="w-fit rounded border border-zinc-300 px-2 py-1 text-black dark:border-zinc-700 dark:text-zinc-50">Retry</button>
      </>
    )}
  </>;
}

export function OutboundTextPreview({
  platforms,
  title,
  description,
  hashtags = [],
  overrides = {},
}: {
  platforms: Platform[];
  title: string;
  description: string;
  hashtags?: string[];
  overrides?: PlatformTextOverrides;
}) {
  return (
    <section aria-label="Outbound text preview" className="flex flex-col gap-2">
      <p className="text-sm font-medium text-black dark:text-zinc-50">
        Outbound text preview
      </p>
      {platforms.map((platform) => {
        const override = overrides[platform];
        const resolved = resolveJobMetadata({
          platform,
          titleOverride: override?.title ?? null,
          descriptionOverride: override?.description ?? null,
          hashtagsOverride: override?.hashtags !== undefined ? JSON.stringify(override.hashtags) : null,
        }, { title, description, hashtags });
        return <div key={platform} className="rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
          <p className="font-medium text-black dark:text-zinc-50">
            {PLATFORM_PRESENTATION[platform].name}
          </p>
          {outboundTextFor(platform, resolved).map((field) => (
            <div key={field.key} className="mt-2">
              <div className="flex justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span>{field.label}</span>
                {field.maxLength !== null && <span>Max {field.maxLength} characters</span>}
              </div>
              <output className="mt-1 block min-h-6 whitespace-pre-wrap text-black dark:text-zinc-50">
                {field.value}
              </output>
            </div>
          ))}
        </div>;
      })}
    </section>
  );
}

export function overrideDraftFor(
  platform: Platform,
  authored: AuthoredText,
  hashtags: string[] = [],
): PlatformTextOverride {
  const draft: PlatformTextOverride = { hashtags };
  for (const field of outboundTextFor(platform, authored)) {
    if (field.key === "description") draft.description = field.value;
    else draft.title = field.value;
  }
  return draft;
}

export function PlatformOverrideEditors({
  platforms,
  title,
  description,
  hashtags,
  overrides,
  onChange,
}: {
  platforms: Platform[];
  title: string;
  description: string;
  hashtags: string[];
  overrides: PlatformTextOverrides;
  onChange: (platform: Platform, override: PlatformTextOverride | null) => void;
}) {
  const authored = { title, description };
  return (
    <section aria-label="Per-platform text overrides" className="flex flex-col gap-2">
      <p className="text-sm font-medium text-black dark:text-zinc-50">
        Customize by platform
      </p>
      {platforms.map((platform) => {
        const override = overrides[platform];
        const fields = outboundTextFor(platform, authored);
        return (
          <details key={platform} className="rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
            <summary className="flex cursor-pointer justify-between gap-2 font-medium text-black dark:text-zinc-50">
              <span>{PLATFORM_PRESENTATION[platform].name}</span>
              <span className={override ? "text-blue-600 dark:text-blue-400" : "text-zinc-500 dark:text-zinc-400"}>
                {override ? "Overridden" : "Shared"}
              </span>
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {override ? (
                <>
                  {fields.map((field) => {
                    const property = field.key === "description" ? "description" : "title";
                    const value = override[property] ?? "";
                    const editorProps = {
                      name: `overrides.${platform}.${property}`,
                      value,
                      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                        onChange(platform, { ...override, [property]: event.target.value }),
                      className: "rounded-md border border-zinc-300 bg-white px-3 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50",
                    };
                    return (
                      <label key={field.key} className="flex flex-col gap-1">
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">{field.label}</span>
                        {field.key === "title"
                          ? <input type="text" {...editorProps} />
                          : <textarea rows={3} {...editorProps} />}
                      </label>
                    );
                  })}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">Hashtags</span>
                    <input
                      type="text"
                      name={`overrides.${platform}.hashtags`}
                      value={(override.hashtags ?? []).join(" ")}
                      onChange={(event) =>
                        onChange(platform, { ...override, hashtags: parseHashtagInput(event.target.value) })}
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                    />
                  </label>
                </>
              ) : (
                <>
                  {fields.map((field) => (
                    <div key={field.key}>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{field.label}</p>
                      <output className="mt-1 block whitespace-pre-wrap text-black dark:text-zinc-50">{field.value}</output>
                    </div>
                  ))}
                  <div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">Hashtags</p>
                    <output className="mt-1 block whitespace-pre-wrap text-black dark:text-zinc-50">
                      {formatHashtags(hashtags) || "—"}
                    </output>
                  </div>
                  <button
                    type="button"
                    onClick={() => onChange(platform, overrideDraftFor(platform, authored, hashtags))}
                    className="w-fit rounded border border-zinc-300 px-2 py-1 text-black dark:border-zinc-700 dark:text-zinc-50"
                  >
                    Customize
                  </button>
                </>
              )}
              {override && (
                <button
                  type="button"
                  onClick={() => onChange(platform, null)}
                  className="w-fit rounded border border-zinc-300 px-2 py-1 text-black dark:border-zinc-700 dark:text-zinc-50"
                >
                  Clear override
                </button>
              )}
            </div>
          </details>
        );
      })}
    </section>
  );
}

function MetadataSourceBadge({
  source,
}: {
  source: "shared" | "overridden" | undefined;
}) {
  return (
    <span className={source === "overridden" ? "text-blue-600 dark:text-blue-400" : "text-zinc-500 dark:text-zinc-400"}>
      {source === "overridden" ? "Overridden" : "Shared"}
    </span>
  );
}

export function JobMetadataEditor({
  job,
  sharedHashtags = [],
  onSave,
}: {
  job: JobView;
  sharedHashtags?: string[];
  onSave: (title: string | null, description: string | null, hashtags: string[] | null) => void | Promise<void>;
}) {
  const shape = uploadPolicyFor(job.platform).text;
  const overrideSource = job.overrideSource ?? job.metadataSource;
  const effectiveMetadata = job.savedMetadata ?? job.effectiveMetadata ?? { title: "", description: "" };
  const effectiveTitle = shape.kind === "caption"
    ? outboundTextFor(job.platform, effectiveMetadata)[0].value
    : effectiveMetadata.title;
  const [draftTitle, setDraftTitle] = useState(
    job.titleOverride ?? effectiveTitle,
  );
  const [draftDescription, setDraftDescription] = useState(
    job.descriptionOverride ?? effectiveMetadata.description,
  );
  const [draftHashtags, setDraftHashtags] = useState(
    (job.hashtagsOverride ?? sharedHashtags).join(" "),
  );
  const [saving, setSaving] = useState(false);

  async function save(title: string | null, description: string | null, hashtags: string[] | null) {
    setSaving(true);
    try {
      await onSave(title, description, hashtags);
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="mt-2 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <summary className="flex cursor-pointer justify-between gap-2">
        <span>Edit platform text</span>
        <MetadataSourceBadge source={overrideSource} />
      </summary>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save(
            draftTitle,
            shape.kind === "caption" ? null : draftDescription,
            parseHashtagInput(draftHashtags),
          );
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {shape.kind === "caption" ? "Caption" : "Title"}
          </span>
          {shape.kind === "caption" ? (
            <textarea
              name={`job-${job.id}-title`}
              rows={3}
              maxLength={shape.captionMaxLength}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          ) : (
            <input
              name={`job-${job.id}-title`}
              type="text"
              maxLength={shape.titleMaxLength ?? undefined}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          )}
        </label>
        {shape.kind === "title-and-description" && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Description</span>
            <textarea
              name={`job-${job.id}-description`}
              rows={3}
              maxLength={shape.descriptionMaxLength ?? undefined}
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Hashtags</span>
          <input
            name={`job-${job.id}-hashtags`}
            type="text"
            value={draftHashtags}
            onChange={(event) => setDraftHashtags(event.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
        </label>
        {job.status === "uploading" && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Saved changes apply to a future attempt, not the post currently in flight.
          </p>
        )}
        <div className="flex gap-2">
          <button type="submit" disabled={saving} className="rounded border border-zinc-300 px-2 py-1 text-black disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50">
            {saving ? "Saving..." : "Save override"}
          </button>
          {overrideSource === "overridden" && (
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(null, null, null)}
              className="rounded border border-zinc-300 px-2 py-1 text-black disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50"
            >
              Clear override
            </button>
          )}
        </div>
      </form>
    </details>
  );
}

export function JobMetadataAudit({ job }: { job: JobView }) {
  if (!job.effectiveMetadata || !job.metadataSource) return null;
  const fields = outboundTextFor(job.platform, job.effectiveMetadata);
  return (
    <section aria-label={`${job.platform} resolved metadata`} className="mt-2 rounded-md bg-zinc-100 px-3 py-2 dark:bg-zinc-900">
      <div className="flex justify-between gap-2 text-xs">
        <span className="font-medium text-black dark:text-zinc-50">Resolved platform text</span>
        <MetadataSourceBadge source={job.metadataSource} />
      </div>
      {fields.map((field) => (
        <div key={field.key} className="mt-2">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{field.label}</p>
          <output className="block whitespace-pre-wrap text-black dark:text-zinc-50">
            {field.value}
          </output>
        </div>
      ))}
    </section>
  );
}

export function JobStatusDetails({
  job,
  fileSize,
  sharedHashtags,
  history = false,
  onRetry,
  onSaveMetadata,
}: {
  job: JobView;
  fileSize?: number;
  sharedHashtags?: string[];
  history?: boolean;
  onRetry: () => void;
  onSaveMetadata: (title: string | null, description: string | null, hashtags: string[] | null) => void | Promise<void>;
}) {
  const percent = transferPercent(job, fileSize);
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-zinc-600 dark:text-zinc-400">{job.platform}</span>
        <span className="font-medium text-black dark:text-zinc-50">
          {STATUS_LABEL[job.status]}
          {percent !== null && ` ${percent}%`}
        </span>
      </div>
      {percent !== null && (
        <div className="h-2 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
          <div
            className="h-full bg-black transition-all dark:bg-zinc-50"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <JobOutcome job={job} onRetry={onRetry} history={history} />
      <JobMetadataAudit job={job} />
      <JobMetadataEditor
        key={`${job.id}:${job.titleOverride}:${job.descriptionOverride}:${job.hashtagsOverride}`}
        job={job}
        sharedHashtags={sharedHashtags}
        onSave={onSaveMetadata}
      />
    </div>
  );
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [hashtagInput, setHashtagInput] = useState("");
  const [overrides, setOverrides] = useState<PlatformTextOverrides>({});
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileIssue, setFileIssue] = useState<string | null>(null);
  const [checkingFile, setCheckingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [upload, setUpload] = useState<UploadView | null>(null);
  const [history, setHistory] = useState<UploadView[]>([]);
  const [youtube, setYoutube] = useState<YouTubeConnectionView | null>(null);
  const [tiktok, setTiktok] = useState<TikTokConnectionView | null>(null);
  const [instagram, setInstagram] = useState<InstagramConnectionView | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // React state (`submitting`) drives the disabled attribute, but a state
  // update isn't applied to the DOM synchronously — a fast double-click can
  // fire two submit events before the button actually disables. This ref is
  // checked and set synchronously, so the second call always bails.
  const submitLockRef = useRef(false);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, []);

  useEffect(() => {
    fetch("/api/uploads")
      .then(async (response) => (response.ok ? response.json() : []))
      .then((data: UploadView[]) => setHistory(data))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    fetch("/api/platforms/youtube")
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data: YouTubeConnectionView | null) => setYoutube(data))
      .catch(() => setYoutube(null));
  }, []);

  useEffect(() => {
    fetch("/api/platforms/tiktok")
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data: TikTokConnectionView | null) => setTiktok(data))
      .catch(() => setTiktok(null));
  }, []);

  useEffect(() => {
    fetch("/api/platforms/instagram")
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data: InstagramConnectionView | null) => setInstagram(data))
      .catch(() => setInstagram(null));
  }, []);

  async function disconnectYouTube() {
    const response = await fetch("/api/platforms/youtube", { method: "DELETE" });
    if (response.ok) {
      setYoutube({ connected: false, externalAccountId: null, externalAccountLabel: null, reconnectNeeded: false });
    }
  }

  async function disconnectTikTok() {
    const response = await fetch("/api/platforms/tiktok", { method: "DELETE" });
    if (response.ok) {
      setTiktok({ connected: false, externalAccountId: null, externalAccountLabel: null, reconnectNeeded: false });
    }
  }

  async function disconnectInstagram() {
    const response = await fetch("/api/platforms/instagram", { method: "DELETE" });
    if (response.ok) {
      setInstagram({ connected: false, externalAccountId: null, externalAccountLabel: null, reconnectNeeded: false });
    }
  }

  function pollStatus(id: string) {
    if (pollRef.current) {
      clearInterval(pollRef.current);
    }
    pollRef.current = setInterval(async () => {
      const response = await fetch(`/api/uploads/${id}`);
      if (!response.ok) {
        return;
      }
      const data: UploadView = await response.json();
      setUpload(data);
      setHistory((current) => current.map((item) => item.id === data.id ? data : item));
      const settled = data.jobs.every(
        (job) => job.status === "done" || job.status === "failed",
      );
      if (settled && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 1000);
  }

  async function selectFile(candidate: File) {
    setFile(candidate);
    setError(null);
    setCheckingFile(false);
    if (!SUPPORTED_VIDEO_TYPES.has(typeFor(candidate))) {
      setFileIssue("Use an MP4, WebM, or MOV video file.");
      return;
    }
    const platformIssue = uploadPolicyViolation(
      candidate,
      uploadTargetPlatforms(youtube, tiktok, instagram),
    );
    if (platformIssue) {
      setFileIssue(`${platformIssue}.`);
      return;
    }
    if (candidate.size > MAX_FILE_SIZE_BYTES) {
      setFileIssue("Use a video smaller than 256 MB.");
      return;
    }

    setCheckingFile(true);
    const url = URL.createObjectURL(candidate);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      setFileIssue(video.duration > MAX_DURATION_SECONDS ? "Use a video three minutes or shorter." : null);
      setCheckingFile(false);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      setFileIssue("This video could not be checked. Choose an MP4, WebM, or MOV file.");
      setCheckingFile(false);
    };
    video.src = url;
  }

  function sendUpload(body: FormData): Promise<UploadView> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", "/api/uploads");
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) setUploadProgress(Math.round((event.loaded / event.total) * 100));
      };
      request.onerror = () => reject(new Error("Upload could not reach OmniPost."));
      request.onload = () => {
        let data: { error?: unknown; requestId?: unknown } = {};
        try {
          data = JSON.parse(request.responseText || "{}");
        } catch {
          // Response wasn't JSON (e.g. a proxy-level error page) — fall
          // through to the generic message below.
        }
        if (request.status >= 200 && request.status < 300) resolve(data as UploadView);
        else {
          const base = typeof data.error === "string" ? data.error : "Upload failed.";
          const suffix = typeof data.requestId === "string" ? ` (ref ${data.requestId} — see server log)` : "";
          reject(new Error(base + suffix));
        }
      };
      request.send(body);
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file || fileIssue || checkingFile || submitLockRef.current) {
      return;
    }
    const platformIssue = uploadPolicyViolation(
      file,
      uploadTargetPlatforms(youtube, tiktok, instagram),
    );
    if (platformIssue) {
      setFileIssue(`${platformIssue}.`);
      return;
    }
    submitLockRef.current = true;

    setSubmitting(true);
    setError(null);
    setUpload(null);
    setUploadProgress(0);

    const body = new FormData();
    body.set("video", file);
    body.set("title", title);
    body.set("description", description);
    const hashtags = parseHashtagInput(hashtagInput);
    if (hashtags.length > 0) {
      body.set("hashtags", JSON.stringify(hashtags));
    }
    if (Object.keys(overrides).length > 0) {
      body.set("overrides", JSON.stringify(overrides));
    }

    try {
      const data = await sendUpload(body);
      setUpload(data);
      setHistory((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      pollStatus(data.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Upload failed.");
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
      setUploadProgress(null);
    }
  }

  async function retryJob(jobId: string, source: UploadView = upload!) {
    const response = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    if (!response.ok || !source) return;
    const retried: Pick<JobView, "id" | "status" | "error"> = await response.json();
    const updated = {
      ...source,
      jobs: source.jobs.map((job) => job.id === retried.id ? { ...job, ...retried } : job),
    };
    setUpload(updated);
    setHistory((current) => current.map((item) => item.id === updated.id ? updated : item));
    pollStatus(updated.id);
  }

  async function saveJobMetadata(
    jobId: string,
    titleOverride: string | null,
    descriptionOverride: string | null,
    hashtagsOverride: string[] | null,
  ) {
    const response = await fetch(`/api/jobs/${jobId}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: titleOverride, description: descriptionOverride, hashtags: hashtagsOverride }),
    });
    if (!response.ok) return;
    const metadata: Pick<JobView,
      | "id"
      | "titleOverride"
      | "descriptionOverride"
      | "hashtagsOverride"
      | "metadataSource"
      | "overrideSource"
      | "effectiveMetadata"
      | "savedMetadata"
      | "metadataAppliesTo"
    > = await response.json();
    const updateUpload = (source: UploadView) => ({
      ...source,
      jobs: source.jobs.map((job) => job.id === metadata.id ? { ...job, ...metadata } : job),
    });
    setUpload((current) => current ? updateUpload(current) : current);
    setHistory((current) => current.map(updateUpload));
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-md flex-col items-center gap-6 px-6 py-16">
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
            OmniPost
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Self-hosted upload pipeline.
          </p>
        </div>

        <section className="flex w-full items-center justify-between rounded-md border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
          <div>
            <p className="font-medium text-black dark:text-zinc-50">YouTube</p>
            <p className="text-zinc-600 dark:text-zinc-400">
              {youtubeConnectionStatusText(youtube)}
            </p>
          </div>
          {youtube?.connected ? (
            <button
              type="button"
              onClick={disconnectYouTube}
              className="rounded-md border border-zinc-300 px-3 py-2 text-black dark:border-zinc-700 dark:text-zinc-50"
            >
              Disconnect
            </button>
          ) : (
            <a
              href="/api/platforms/youtube/connect"
              className="rounded-md bg-black px-3 py-2 text-white dark:bg-zinc-50 dark:text-black"
            >
              Connect YouTube
            </a>
          )}
        </section>

        <section className="flex w-full flex-col gap-2 rounded-md border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-black dark:text-zinc-50">TikTok</p>
              <p className="text-zinc-600 dark:text-zinc-400">
                {tiktokConnectionStatusText(tiktok)}
              </p>
            </div>
            {tiktok?.connected ? (
              <button
                type="button"
                onClick={disconnectTikTok}
                className="rounded-md border border-zinc-300 px-3 py-2 text-black dark:border-zinc-700 dark:text-zinc-50"
              >
                Disconnect
              </button>
            ) : (
              <a
                href="/api/platforms/tiktok/connect"
                className="rounded-md bg-black px-3 py-2 text-white dark:bg-zinc-50 dark:text-black"
              >
                Connect TikTok
              </a>
            )}
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Posts are private (SELF_ONLY) until TikTok approves this app for
            public posting.
          </p>
        </section>

        <section className="flex w-full flex-col gap-2 rounded-md border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-black dark:text-zinc-50">Instagram</p>
              <p className="text-zinc-600 dark:text-zinc-400">
                {instagramConnectionStatusText(instagram)}
              </p>
            </div>
            {instagram?.connected ? (
              <button
                type="button"
                onClick={disconnectInstagram}
                className="rounded-md border border-zinc-300 px-3 py-2 text-black dark:border-zinc-700 dark:text-zinc-50"
              >
                Disconnect
              </button>
            ) : (
              <a
                href="/api/platforms/instagram/connect"
                className="rounded-md bg-black px-3 py-2 text-white dark:bg-zinc-50 dark:text-black"
              >
                Connect Instagram
              </a>
            )}
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Requires an Instagram Business or Creator account linked to a Facebook Page.
          </p>
        </section>

        <form onSubmit={handleSubmit} className="flex w-full flex-col gap-4">
          <label
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const dropped = event.dataTransfer.files[0];
              if (dropped) {
                void selectFile(dropped);
              }
            }}
            className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed px-4 py-8 text-center text-sm transition-colors ${
              dragging
                ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-900"
                : "border-zinc-300 dark:border-zinc-700"
            }`}
          >
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(event) => {
                const selected = event.target.files?.[0];
                if (selected) void selectFile(selected);
              }}
            />
            {file ? (
              <span className="text-black dark:text-zinc-50">
                {file.name} ({(file.size / (1024 * 1024)).toFixed(1)} MB)
              </span>
            ) : (
              <span className="text-zinc-500 dark:text-zinc-400">
                Click or drag a video file here
              </span>
            )}
          </label>

          <input
            type="text"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Title"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />

          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description"
            rows={3}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />

          <input
            type="text"
            value={hashtagInput}
            onChange={(event) => setHashtagInput(event.target.value)}
            placeholder="Hashtags (space or comma separated, e.g. launch demo)"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />

          <OutboundTextPreview
            platforms={uploadTargetPlatforms(youtube, tiktok, instagram)}
            title={title}
            description={description}
            hashtags={parseHashtagInput(hashtagInput)}
            overrides={overrides}
          />

          <PlatformOverrideEditors
            platforms={uploadTargetPlatforms(youtube, tiktok, instagram)}
            title={title}
            description={description}
            hashtags={parseHashtagInput(hashtagInput)}
            overrides={overrides}
            onChange={(platform, override) => {
              setOverrides((current) => {
                const next = { ...current };
                if (override === null) delete next[platform];
                else next[platform] = override;
                return next;
              });
            }}
          />

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          {fileIssue && (
            <p className="text-sm text-amber-700 dark:text-amber-300">{fileIssue}</p>
          )}

          {submitting && uploadProgress !== null && (
            <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
              <div className="flex justify-between"><span>Sending video</span><span>{uploadProgress}%</span></div>
              <div className="h-2 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800"><div className="h-full bg-black transition-all dark:bg-zinc-50" style={{ width: `${uploadProgress}%` }} /></div>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || checkingFile || !file || Boolean(fileIssue) || title.trim().length === 0}
            className="rounded-md bg-black px-3 py-2 text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
          >
            {submitting ? "Uploading..." : "Upload"}
          </button>
        </form>

        {upload && (
          <div className="w-full rounded-md border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
            {upload.jobs.length > 0 && upload.jobs.every((job) => job.status === "done") && (
              <p className="mb-2 font-medium text-green-700 dark:text-green-400">Uploaded successfully.</p>
            )}
            {upload.jobs.map((job) => (
              <JobStatusDetails
                key={job.id}
                job={job}
                fileSize={upload.fileSize}
                sharedHashtags={upload.hashtags}
                onRetry={() => retryJob(job.id)}
                onSaveMetadata={(title, description, hashtags) => saveJobMetadata(job.id, title, description, hashtags)}
              />
            ))}
          </div>
        )}

        <section className="flex w-full flex-col gap-3">
          <h2 className="text-lg font-medium text-black dark:text-zinc-50">Upload history</h2>
          {history.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No uploads yet.</p>
          ) : history.map((item) => (
            <div key={item.id} className="rounded-md border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
              <div className="flex justify-between gap-3"><span className="truncate font-medium text-black dark:text-zinc-50">{item.title ?? item.fileName ?? "Upload"}</span><time className="shrink-0 text-zinc-600 dark:text-zinc-400">{item.createdAt ? new Date(item.createdAt).toLocaleString() : "Just now"}</time></div>
              {item.jobs.map((job) => (
                <JobStatusDetails
                  key={job.id}
                  job={job}
                  sharedHashtags={item.hashtags}
                  history
                  onRetry={() => retryJob(job.id, item)}
                  onSaveMetadata={(title, description, hashtags) => saveJobMetadata(job.id, title, description, hashtags)}
                />
              ))}
            </div>
          ))}
        </section>

        <footer className="flex gap-4 border-t border-zinc-200 pt-6 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <a href="/terms" className="underline">Terms of Service</a>
          <a href="/privacy" className="underline">Privacy Policy</a>
        </footer>
      </main>
    </div>
  );
}
