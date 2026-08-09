"use client";

import { useEffect, useRef, useState } from "react";
import type { JobView, UploadView } from "@/lib/dashboard-types";

export function useUploadActivity() {
  const [history, setHistory] = useState<UploadView[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch("/api/uploads")
      .then(async (response) => (response.ok ? response.json() : []))
      .then((data: UploadView[]) => setHistory(data))
      .catch(() => setHistory([]));

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function pollStatus(id: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const response = await fetch(`/api/uploads/${id}`);
      if (!response.ok) return;
      const data: UploadView = await response.json();
      setHistory((current) => current.map((item) => item.id === data.id ? data : item));
      if (data.jobs.every((job) => job.status === "done" || job.status === "failed")) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 1000);
  }

  function addUpload(upload: UploadView) {
    setHistory((current) => [upload, ...current.filter((item) => item.id !== upload.id)]);
    pollStatus(upload.id);
  }

  async function retryJob(jobId: string, source: UploadView) {
    const response = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    if (!response.ok) return;
    const retried: Pick<JobView, "id" | "status" | "error"> = await response.json();
    const updated = {
      ...source,
      jobs: source.jobs.map((job) => job.id === retried.id ? { ...job, ...retried } : job),
    };
    setHistory((current) => current.map((item) => item.id === updated.id ? updated : item));
    pollStatus(updated.id);
  }

  async function saveJobMetadata(
    jobId: string,
    title: string | null,
    description: string | null,
    hashtags: string[] | null,
  ) {
    const response = await fetch(`/api/jobs/${jobId}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, description, hashtags }),
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
    setHistory((current) => current.map((upload) => ({
      ...upload,
      jobs: upload.jobs.map((job) => job.id === metadata.id ? { ...job, ...metadata } : job),
    })));
  }

  return { history, addUpload, retryJob, saveJobMetadata };
}
