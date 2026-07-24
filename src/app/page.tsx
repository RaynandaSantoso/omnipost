"use client";

import { useEffect, useRef, useState } from "react";

interface JobView {
  id: string;
  platform: string;
  status: "pending" | "uploading" | "done" | "failed";
  resultUrl: string | null;
  error: string | null;
}

interface UploadView {
  id: string;
  jobs: JobView[];
}

interface YouTubeConnectionView {
  connected: boolean;
  channelId: string | null;
  reconnectNeeded: boolean;
}

const STATUS_LABEL: Record<JobView["status"], string> = {
  pending: "Pending",
  uploading: "Uploading",
  done: "Done",
  failed: "Failed",
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadView | null>(null);
  const [youtube, setYoutube] = useState<YouTubeConnectionView | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, []);

  useEffect(() => {
    fetch("/api/platforms/youtube")
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data: YouTubeConnectionView | null) => setYoutube(data))
      .catch(() => setYoutube(null));
  }, []);

  async function disconnectYouTube() {
    const response = await fetch("/api/platforms/youtube", { method: "DELETE" });
    if (response.ok) {
      setYoutube({ connected: false, channelId: null, reconnectNeeded: false });
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
      const settled = data.jobs.every(
        (job) => job.status === "done" || job.status === "failed",
      );
      if (settled && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 1000);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      return;
    }

    setSubmitting(true);
    setError(null);
    setUpload(null);

    const body = new FormData();
    body.set("video", file);
    body.set("title", title);
    body.set("description", description);

    const response = await fetch("/api/uploads", { method: "POST", body });
    setSubmitting(false);

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(
        typeof data.error === "string" ? data.error : "Upload failed.",
      );
      return;
    }

    const data: UploadView = await response.json();
    setUpload(data);
    pollStatus(data.id);
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
              {youtube?.connected
                ? youtube.reconnectNeeded
                  ? "Reconnect needed"
                  : `Connected to ${youtube.channelId}`
                : "Not connected"}
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
                setFile(dropped);
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
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
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

          <button
            type="submit"
            disabled={submitting || !file || title.trim().length === 0}
            className="rounded-md bg-black px-3 py-2 text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
          >
            {submitting ? "Uploading..." : "Upload"}
          </button>
        </form>

        {upload && (
          <div className="w-full rounded-md border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
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
                {job.status === "done" && job.resultUrl && (
                  <a
                    href={job.resultUrl}
                    className="truncate text-blue-600 underline dark:text-blue-400"
                  >
                    {job.resultUrl}
                  </a>
                )}
                {job.status === "failed" && job.error && (
                  <span className="text-red-600 dark:text-red-400">
                    {job.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
