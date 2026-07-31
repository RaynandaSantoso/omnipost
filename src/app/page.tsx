"use client";

import { useEffect, useRef, useState } from "react";
import type { Platform } from "@/lib/platform";
import { uploadPolicyViolation } from "@/lib/platform-upload-policy";

interface JobView {
  id: string;
  platform: Platform;
  status: "pending" | "uploading" | "done" | "failed";
  resultUrl: string | null;
  error: string | null;
}

interface UploadView {
  id: string;
  title?: string;
  fileName?: string;
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

const STATUS_LABEL: Record<JobView["status"], string> = {
  pending: "Pending",
  uploading: "Uploading",
  done: "Done",
  failed: "Failed",
};

const MAX_FILE_SIZE_BYTES = 256 * 1024 * 1024;
const MAX_DURATION_SECONDS = 180;
const SUPPORTED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

function typeFor(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension === "mov" ? "video/quicktime" : `video/${extension ?? "unknown"}`;
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

function readableFailure(job: JobView): string {
  const name = job.platform === "tiktok" ? "TikTok" : job.platform === "youtube" ? "YouTube" : "The platform";
  if (!job.error) return "";
  if (job.error.toLowerCase().includes("reconnect")) return `${name} needs to be reconnected before this upload can continue.`;
  if (job.error.toLowerCase().includes("credential")) return `${name} rejected the connected account credentials.`;
  if (job.error.includes("429")) return `${name} is rate limiting uploads. It will retry automatically.`;
  return job.error;
}

function successMessageFor(job: JobView): string | null {
  return job.status === "done" && job.platform === "tiktok"
    ? "Posted privately to your TikTok account (SELF_ONLY)."
    : null;
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
  const successMessage = successMessageFor(job);
  return <>
    {job.status === "done" && (
      <>
        {job.resultUrl && job.platform !== "tiktok" && (
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

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
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
    const platformIssue = tiktok?.connected
      ? uploadPolicyViolation(candidate, ["tiktok"])
      : null;
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
    const platformIssue = tiktok?.connected
      ? uploadPolicyViolation(file, ["tiktok"])
      : null;
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
              <div key={job.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-600 dark:text-zinc-400">
                    {job.platform}
                  </span>
                  <span className="font-medium text-black dark:text-zinc-50">
                    {STATUS_LABEL[job.status]}
                  </span>
                </div>
                <JobOutcome job={job} onRetry={() => retryJob(job.id)} />
              </div>
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
                <div key={job.id} className="mt-2 flex flex-col gap-1">
                  <div className="flex justify-between"><span className="text-zinc-600 dark:text-zinc-400">{job.platform}</span><span className="text-black dark:text-zinc-50">{STATUS_LABEL[job.status]}</span></div>
                  <JobOutcome job={job} onRetry={() => retryJob(job.id, item)} history />
                </div>
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
