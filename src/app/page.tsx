"use client";

import { useEffect, useRef, useState } from "react";
import {
  ConnectionStrip,
  DashboardShell,
  VideoPicker,
} from "@/components/dashboard-shell";
import { PLATFORM_LABEL, type Platform } from "@/lib/platform";
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
import type { JobView, UploadView } from "@/lib/dashboard-types";
import { useUploadActivity } from "@/hooks/use-upload-activity";
import {
  connectionLoaded,
  connectionOf,
  connectionRoute,
  connectionStateText,
  connectionStatusText,
  connectionsSettled,
  connectionUnavailable,
  connectRoute,
  loadingConnections,
  CONNECTABLE_PLATFORMS,
  CONNECTION_PRESENTATION,
  disconnected,
  type ConnectablePlatform,
  type ConnectionLoadState,
  type ConnectionsView,
  type ConnectionStatus,
} from "@/lib/connection-status";

export type { JobView, UploadView } from "@/lib/dashboard-types";

const STATUS_LABEL: Record<JobView["status"], string> = {
  pending: "Pending",
  uploading: "Uploading",
  done: "Done",
  failed: "Failed",
};

// How long a platform's status request may take before it counts as failed.
// Generous: these are local database reads, so anything near this is broken.
const STATUS_TIMEOUT_MS = 10_000;

const MAX_FILE_SIZE_BYTES = 256 * 1024 * 1024;
const MAX_DURATION_SECONDS = 180;
const SUPPORTED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

// How a Job's outcome reads once it settles. The platform's own name is not
// repeated here — that lives in PLATFORM_LABEL, so the connect block and the
// job status can't disagree about what a platform is called.
interface PlatformPresentation {
  linkResult: boolean;
  uploadingMessage?: string;
  successMessage?: (job: JobView) => string | null;
}

const PLATFORM_PRESENTATION: Record<Platform, PlatformPresentation> = {
  "dry-run": { linkResult: true },
  youtube: { linkResult: true },
  tiktok: {
    linkResult: false,
    successMessage: () => "Posted privately to your TikTok account (SELF_ONLY).",
  },
  instagram: {
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

function typeFor(file: Pick<File, "name" | "type">): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension === "mov" ? "video/quicktime" : `video/${extension ?? "unknown"}`;
}

/**
 * Everything about a file that can be judged without decoding it.
 *
 * The platform policy check lives here rather than beside the duration probe
 * because its answer depends on `platforms`: the same file passes for one set
 * of targets and fails for another. That is precisely why the form must not
 * ask this question until it knows which platforms it is uploading to.
 */
export function fileFormatIssue(
  candidate: Pick<File, "name" | "size" | "type">,
  platforms: Platform[],
): string | null {
  if (!SUPPORTED_VIDEO_TYPES.has(typeFor(candidate))) {
    return "Use an MP4, WebM, or MOV video file.";
  }
  const platformIssue = uploadPolicyViolation(candidate, platforms);
  if (platformIssue) return `${platformIssue}.`;
  if (candidate.size > MAX_FILE_SIZE_BYTES) {
    return "Use a video smaller than 256 MB.";
  }
  return null;
}

// The browser has to decode the file's metadata to learn how long it is, so
// this leg is async where the checks above it are not. It depends only on the
// file, never on which platforms are connected.
function videoDurationIssue(candidate: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(candidate);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(
        video.duration > MAX_DURATION_SECONDS
          ? "Use a video three minutes or shorter."
          : null,
      );
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve("This video could not be checked. Choose an MP4, WebM, or MOV file.");
    };
    video.src = url;
  });
}

// Only meaningful once connectionsSettled(connections) is true: a platform
// that has not answered yet is absent from the result, which would read as
// "not a target" rather than "not known yet".
export function uploadTargetPlatforms(
  connections: ConnectionsView,
  selected?: ReadonlySet<ConnectablePlatform>,
): Platform[] {
  const connected = CONNECTABLE_PLATFORMS.filter(
    (platform) => connectionOf(connections[platform])?.connected,
  );
  if (connected.length === 0) return ["dry-run"];
  return selected ? connected.filter((platform) => selected.has(platform)) : connected;
}

// Dry-run is the server's no-account fallback, never an operator-selected
// destination. Omitting the field preserves that distinction at the API.
export function platformsForUploadRequest(platforms: Platform[]): Platform[] | undefined {
  return platforms.length === 1 && platforms[0] === "dry-run" ? undefined : platforms;
}

// Per-platform entry points into the shared status text. They exist so each
// platform's wording stays pinned by its own test, catching a regression in
// the shared implementation at the platform that would suffer it.
export function youtubeConnectionStatusText(status: ConnectionStatus | null): string {
  return connectionStatusText("youtube", status);
}

export function tiktokConnectionStatusText(status: ConnectionStatus | null): string {
  return connectionStatusText("tiktok", status);
}

export function instagramConnectionStatusText(status: ConnectionStatus | null): string {
  return connectionStatusText("instagram", status);
}

export function PlatformConnectionSection({
  platform,
  state,
  onDisconnect,
}: {
  platform: ConnectablePlatform;
  state: ConnectionLoadState;
  onDisconnect: (platform: ConnectablePlatform) => void | Promise<void>;
}) {
  const label = PLATFORM_LABEL[platform];
  const { disclaimer } = CONNECTION_PRESENTATION[platform];
  const connection = connectionOf(state);
  return (
    // Three visually identical bordered blocks, told apart only by their
    // heading text — which a screen reader does not read as a section name.
    <section
      aria-label={`${label} connection`}
      className="flex w-full flex-col gap-2 rounded-md border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-black dark:text-zinc-50">{label}</p>
          <p className="text-zinc-600 dark:text-zinc-400">
            {connectionStateText(platform, state)}
          </p>
        </div>
        {/*
          While the status is still loading, neither control can be offered
          honestly — "Connect" asserts there is no linked account and
          "Disconnect" asserts there is one. After a failed request the state
          is equally unknown, but connecting works either way, so it stays
          available rather than leaving a dead row until the next reload.
        */}
        {state.phase === "loading" ? null : connection?.connected ? (
          <button
            type="button"
            onClick={() => onDisconnect(platform)}
            className="rounded-md border border-zinc-300 px-3 py-2 text-black dark:border-zinc-700 dark:text-zinc-50"
          >
            Disconnect
          </button>
        ) : (
          <a
            href={connectRoute(platform)}
            className="rounded-md bg-black px-3 py-2 text-white dark:bg-zinc-50 dark:text-black"
          >
            Connect {label}
          </a>
        )}
      </div>
      {disclaimer ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-500">{disclaimer}</p>
      ) : null}
    </section>
  );
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
  const name = PLATFORM_LABEL[job.platform];
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
  connectedPlatforms,
  title,
  description,
  hashtags = [],
  overrides = {},
  onSelectionChange,
}: {
  platforms: Platform[];
  connectedPlatforms?: ConnectablePlatform[];
  title: string;
  description: string;
  hashtags?: string[];
  overrides?: PlatformTextOverrides;
  onSelectionChange?: (platform: ConnectablePlatform, selected: boolean) => void;
}) {
  const previewPlatforms = connectedPlatforms ?? platforms;
  return (
    <section aria-label="Outbound text preview" className="flex flex-col gap-2">
      <p className="text-sm font-medium text-black dark:text-zinc-50">
        Outbound text preview
      </p>
      {previewPlatforms.map((platform) => {
        const selected = platforms.includes(platform);
        if (!selected) {
          return (
            <div
              key={platform}
              className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-sm opacity-50 dark:border-zinc-800"
            >
              <label className="flex cursor-pointer items-center gap-2">
                {onSelectionChange ? (
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={(event) => {
                      if (platform !== "dry-run") onSelectionChange(platform, event.target.checked);
                    }}
                  />
                ) : null}
                <span className="font-medium text-black dark:text-zinc-50">{PLATFORM_LABEL[platform]}</span>
              </label>
              <span className="text-xs text-zinc-600 dark:text-zinc-400">Not selected</span>
            </div>
          );
        }
        const override = overrides[platform];
        const resolved = resolveJobMetadata({
          platform,
          titleOverride: override?.title ?? null,
          descriptionOverride: override?.description ?? null,
          hashtagsOverride: override?.hashtags !== undefined ? JSON.stringify(override.hashtags) : null,
        }, { title, description, hashtags });
        const fields = outboundTextFor(platform, resolved);
        const composedHashtags = uploadPolicyFor(platform).text.kind === "caption"
          && override?.title !== undefined
          ? []
          : override?.hashtags ?? hashtags;
        const overLimit = fields.some(
          (field) => field.maxLength !== null && field.value.length > field.maxLength,
        );
        const diverges = Boolean(override) || fields.some((field) => {
          const authoredValue = field.key === "description" ? description : title;
          return field.value !== authoredValue;
        });
        return (
          <details
            key={platform}
            open={overLimit || diverges}
            className={`rounded-md border px-3 py-2 text-sm ${
              overLimit
                ? "border-red-400 bg-red-50 dark:border-red-800 dark:bg-red-950/20"
                : "border-zinc-200 dark:border-zinc-800"
            }`}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2 font-medium text-black dark:text-zinc-50">
                {onSelectionChange && platform !== "dry-run" ? (
                  <input
                    type="checkbox"
                    checked
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => onSelectionChange(platform, event.target.checked)}
                  />
                ) : null}
                {PLATFORM_LABEL[platform]}
              </label>
              <span className="flex flex-wrap justify-end gap-x-3 text-xs text-zinc-600 dark:text-zinc-400">
                {fields.map((field) => (
                  <span
                    key={field.key}
                    className={field.maxLength !== null && field.value.length > field.maxLength
                      ? "font-semibold text-red-700 dark:text-red-300"
                      : undefined}
                  >
                    {field.label.toLowerCase()} {field.value.length}
                    {field.maxLength !== null ? `/${field.maxLength}` : ""}
                    {field.maxLength === null || field.value.length <= field.maxLength ? " ✓" : " — too long"}
                  </span>
                ))}
              </span>
            </summary>
            <div className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-800">
              {fields.map((field) => (
                <div key={field.key} className="mt-2 first:mt-0">
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{field.label}</p>
                  <output className="mt-1 block min-h-6 whitespace-pre-wrap text-black dark:text-zinc-50">
                    {field.value}
                  </output>
                </div>
              ))}
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Composed hashtags: {formatHashtags(composedHashtags) || "—"}
              </p>
              {platform === "tiktok" && CONNECTION_PRESENTATION.tiktok.disclaimer ? (
                <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                  {CONNECTION_PRESENTATION.tiktok.disclaimer}
                </p>
              ) : null}
            </div>
          </details>
        );
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
              <span>{PLATFORM_LABEL[platform]}</span>
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
  showMetadataAudit = true,
  onRetry,
  onSaveMetadata,
}: {
  job: JobView;
  fileSize?: number;
  sharedHashtags?: string[];
  history?: boolean;
  showMetadataAudit?: boolean;
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
      {showMetadataAudit ? <JobMetadataAudit job={job} /> : null}
      <JobMetadataEditor
        key={`${job.id}:${job.titleOverride}:${job.descriptionOverride}:${job.hashtagsOverride}`}
        job={job}
        sharedHashtags={sharedHashtags}
        onSave={onSaveMetadata}
      />
    </div>
  );
}

function sharedUploadMetadata(upload: UploadView): AuthoredText | null {
  if (upload.jobs.length === 0) return null;
  if (!upload.jobs.every((job) => job.metadataSource === "shared")) return null;
  if (upload.title === undefined || upload.description === undefined) return null;
  return { title: upload.title, description: upload.description };
}

function uploadIsInFlight(upload: UploadView): boolean {
  return upload.jobs.some((job) => job.status === "pending" || job.status === "uploading");
}

export function UploadActivityList({
  uploads,
  onRetry,
  onSaveMetadata,
}: {
  uploads: UploadView[];
  onRetry: (jobId: string, upload: UploadView) => void;
  onSaveMetadata: (
    jobId: string,
    title: string | null,
    description: string | null,
    hashtags: string[] | null,
  ) => void | Promise<void>;
}) {
  if (uploads.length === 0) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">No uploads yet.</p>;
  }

  const orderedUploads = uploads
    .map((upload, originalIndex) => ({ upload, originalIndex }))
    .sort((left, right) => {
      const liveOrder = Number(uploadIsInFlight(right.upload)) - Number(uploadIsInFlight(left.upload));
      return liveOrder || left.originalIndex - right.originalIndex;
    })
    .map(({ upload }) => upload);

  return (
    <div className="flex flex-col gap-3">
      {orderedUploads.map((upload, index) => {
        const sharedMetadata = sharedUploadMetadata(upload);
        return (
          <details
            key={upload.id}
            open={index === 0}
            aria-label={`${upload.id} upload`}
            className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3">
              <span className="min-w-0 flex-1 truncate font-medium text-black dark:text-zinc-50">
                {upload.title ?? upload.fileName ?? "Upload"}
              </span>
              <time className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                {upload.createdAt ? new Date(upload.createdAt).toLocaleString() : "Just now"}
              </time>
              <span className="flex shrink-0 gap-1">
                {upload.jobs.map((job) => (
                  <span
                    key={job.id}
                    className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                  >
                    {PLATFORM_LABEL[job.platform]} · {STATUS_LABEL[job.status]}
                  </span>
                ))}
              </span>
            </summary>
            <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
              {sharedMetadata ? (
                <section aria-label="Shared resolved text" className="rounded-md bg-zinc-100 px-3 py-2 dark:bg-zinc-900">
                  <div className="flex justify-between gap-2 text-xs">
                    <span className="font-medium text-black dark:text-zinc-50">Resolved text</span>
                    <span className="text-zinc-500 dark:text-zinc-400">Shared by every platform</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-black dark:text-zinc-50">
                    {sharedMetadata.title}
                    {sharedMetadata.description ? `\n\n${sharedMetadata.description}` : ""}
                    {upload.hashtags?.length ? `\n\n${formatHashtags(upload.hashtags)}` : ""}
                  </p>
                </section>
              ) : null}
              <div className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800">
                {upload.jobs.map((job) => (
                  <JobStatusDetails
                    key={job.id}
                    job={job}
                    fileSize={upload.fileSize}
                    sharedHashtags={upload.hashtags}
                    history={index > 0}
                    showMetadataAudit={!sharedMetadata || job.metadataSource === "overridden"}
                    onRetry={() => onRetry(job.id, upload)}
                    onSaveMetadata={(title, description, hashtags) =>
                      onSaveMetadata(job.id, title, description, hashtags)}
                  />
                ))}
              </div>
            </div>
          </details>
        );
      })}
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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const { history, addUpload, retryJob, saveJobMetadata } = useUploadActivity();
  const [connections, setConnections] = useState<ConnectionsView>(loadingConnections);
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<ConnectablePlatform>>(
    () => new Set(CONNECTABLE_PLATFORMS),
  );
  const previewUrlRef = useRef<string | null>(null);
  // A file's verdict is re-derived whenever the target platforms change, so
  // two checks can be in flight at once (the duration probe is async). Only
  // the newest may write its answer.
  const fileCheckRef = useRef(0);
  const durationIssueRef = useRef<{ file: File; issue: string | null } | null>(null);
  // React state (`submitting`) drives the disabled attribute, but a state
  // update isn't applied to the DOM synchronously — a fast double-click can
  // fire two submit events before the button actually disables. This ref is
  // checked and set synchronously, so the second call always bails.
  const submitLockRef = useRef(false);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // One request per platform, each landing on its own key so a slow or
    // failing platform never holds up the others. A request that fails lands
    // as "unavailable" rather than as an empty status: it is not evidence
    // that the account is disconnected.
    for (const platform of CONNECTABLE_PLATFORMS) {
      fetch(connectionRoute(platform), {
        // The file check waits for every platform to report, so a request
        // that hangs rather than fails would leave the form unable to judge a
        // file at all. Time out into "unavailable" instead: an answer the
        // operator can see beats a wait they cannot.
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      })
        .then(async (response) =>
          response.ok
            ? connectionLoaded((await response.json()) as ConnectionStatus)
            : connectionUnavailable(),
        )
        .catch(() => connectionUnavailable())
        .then((state) => {
          setConnections((current) => ({ ...current, [platform]: state }));
        });
    }
  }, []);

  async function disconnect(platform: ConnectablePlatform) {
    const response = await fetch(connectionRoute(platform), { method: "DELETE" });
    if (response.ok) {
      setConnections((current) => ({
        ...current,
        [platform]: connectionLoaded(disconnected()),
      }));
    }
  }

  function selectFile(candidate: File) {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = URL.createObjectURL(candidate);
    setPreviewUrl(previewUrlRef.current);
    setFile(candidate);
    setDurationSeconds(null);
    setError(null);
    // No verdict is offered here. The effect below reaches one once it knows
    // which platforms the file has to satisfy; until then the form is
    // "checking", which is what keeps Upload disabled.
    setFileIssue(null);
    setCheckingFile(true);
  }

  function removeFile() {
    ++fileCheckRef.current;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreviewUrl(null);
    setFile(null);
    setFileIssue(null);
    setCheckingFile(false);
    durationIssueRef.current = null;
    setDurationSeconds(null);
  }

  useEffect(() => {
    if (!file) return;
    // Which limits apply depends on which platforms are connected. Answering
    // before every platform has reported means measuring the file against
    // dry-run policy and then contradicting that verdict, with nothing having
    // changed from the operator's point of view, the moment the real statuses
    // land. Re-running when `connections` changes also keeps the verdict true
    // after a disconnect moves the target platforms.
    if (!connectionsSettled(connections)) return;

    const check = ++fileCheckRef.current;
    const settle = (issue: string | null) => {
      if (check !== fileCheckRef.current) return;
      setFileIssue(issue);
      setCheckingFile(false);
    };

    const formatIssue = fileFormatIssue(
      file,
      uploadTargetPlatforms(connections, selectedPlatforms),
    );
    if (formatIssue) {
      settle(formatIssue);
      return;
    }

    // Decoding a 256 MB file is not free, and how long it runs for does not
    // depend on the connections that triggered this re-check — so each file
    // is probed once and the answer reused.
    const probed = durationIssueRef.current;
    if (probed?.file === file) {
      settle(probed.issue);
      return;
    }

    setCheckingFile(true);
    void videoDurationIssue(file).then((issue) => {
      durationIssueRef.current = { file, issue };
      settle(issue);
    });
  }, [file, connections, selectedPlatforms]);

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
    // `checkingFile` already covers the unsettled case — it stays true until
    // the effect above reaches a verdict — but the guard is stated outright
    // so the re-check below can never run against dry-run targets that the
    // arriving statuses are about to replace.
    if (
      !file
      || fileIssue
      || checkingFile
      || !connectionsSettled(connections)
      || uploadTargetPlatforms(connections, selectedPlatforms).length === 0
      || submitLockRef.current
    ) {
      return;
    }
    const platformIssue = uploadPolicyViolation(
      file,
      uploadTargetPlatforms(connections, selectedPlatforms),
    );
    if (platformIssue) {
      setFileIssue(`${platformIssue}.`);
      return;
    }
    submitLockRef.current = true;

    setSubmitting(true);
    setError(null);
    setUploadProgress(0);

    const body = new FormData();
    body.set("video", file);
    body.set("title", title);
    body.set("description", description);
    const hashtags = parseHashtagInput(hashtagInput);
    if (hashtags.length > 0) {
      body.set("hashtags", JSON.stringify(hashtags));
    }
    const targetOverrides = Object.fromEntries(
      Object.entries(overrides).filter(([platform]) => targetPlatforms.includes(platform as Platform)),
    );
    if (Object.keys(targetOverrides).length > 0) {
      body.set("overrides", JSON.stringify(targetOverrides));
    }
    const requestedPlatforms = platformsForUploadRequest(targetPlatforms);
    if (requestedPlatforms) {
      body.set("platforms", JSON.stringify(requestedPlatforms));
    }

    try {
      const data = await sendUpload(body);
      addUpload(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Upload failed.");
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
      setUploadProgress(null);
    }
  }

  const settled = connectionsSettled(connections);
  const connectedPlatforms = settled
    ? CONNECTABLE_PLATFORMS.filter((platform) => connectionOf(connections[platform])?.connected)
    : [];
  const targetPlatforms = settled ? uploadTargetPlatforms(connections, selectedPlatforms) : [];
  const hashtags = parseHashtagInput(hashtagInput);

  const compose = (
    <form onSubmit={handleSubmit} className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-medium text-black dark:text-zinc-50">Compose</h2>
        {!settled ? <span className="text-xs text-zinc-500">Checking connections…</span> : null}
      </div>
      <fieldset disabled={!settled || submitting} className="flex flex-col gap-4 disabled:opacity-60">
        <div className="grid grid-cols-[minmax(180px,240px)_minmax(0,1fr)] items-start gap-4">
          <VideoPicker
            file={file}
            previewUrl={previewUrl}
            durationSeconds={durationSeconds}
            dragging={dragging}
            onDragStateChange={setDragging}
            onSelect={selectFile}
            onRemove={removeFile}
            onDurationChange={setDurationSeconds}
          />
          <div className="flex min-w-0 flex-col gap-4">
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
              rows={6}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <input
              type="text"
              value={hashtagInput}
              onChange={(event) => setHashtagInput(event.target.value)}
              placeholder="Hashtags (space or comma separated)"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <PlatformOverrideEditors
              platforms={targetPlatforms}
              title={title}
              description={description}
              hashtags={hashtags}
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
          </div>
        </div>

        <OutboundTextPreview
          platforms={targetPlatforms}
          connectedPlatforms={connectedPlatforms}
          title={title}
          description={description}
          hashtags={hashtags}
          overrides={overrides}
          onSelectionChange={(platform, selected) => {
            setSelectedPlatforms((current) => {
              const next = new Set(current);
              if (selected) next.add(platform);
              else next.delete(platform);
              return next;
            });
          }}
        />

        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        {fileIssue ? <p className="text-sm text-amber-700 dark:text-amber-300">{fileIssue}</p> : null}
        {submitting && uploadProgress !== null ? (
          <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
            <div className="flex justify-between"><span>Sending video</span><span>{uploadProgress}%</span></div>
            <div className="h-2 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
              <div className="h-full bg-black transition-all dark:bg-zinc-50" style={{ width: `${uploadProgress}%` }} />
            </div>
          </div>
        ) : null}
        <button
          type="submit"
          disabled={submitting || checkingFile || !file || Boolean(fileIssue) || title.trim().length === 0 || targetPlatforms.length === 0}
          className="rounded-md bg-black px-3 py-2 text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {submitting ? "Uploading..." : "Upload"}
        </button>
      </fieldset>
    </form>
  );

  const activity = (
    <div className="rounded-xl border border-zinc-200 bg-zinc-100/60 p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
      <h2 className="mb-4 text-lg font-medium text-black dark:text-zinc-50">Activity</h2>
      <UploadActivityList
        uploads={history}
        onRetry={retryJob}
        onSaveMetadata={saveJobMetadata}
      />
    </div>
  );

  return (
    <DashboardShell
      connections={<ConnectionStrip connections={connections} onDisconnect={disconnect} />}
      compose={compose}
      activity={activity}
      footer={(
        <footer className="flex gap-4 border-t border-zinc-200 pt-5 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <a href="/terms" className="underline">Terms of Service</a>
          <a href="/privacy" className="underline">Privacy Policy</a>
        </footer>
      )}
    />
  );
}
