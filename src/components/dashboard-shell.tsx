"use client";

import type { DragEvent, ReactNode } from "react";
import {
  CONNECTABLE_PLATFORMS,
  connectRoute,
  connectionOf,
  type ConnectablePlatform,
  type ConnectionsView,
} from "@/lib/connection-status";
import { PLATFORM_LABEL } from "@/lib/platform";

export function DashboardShell({
  connections,
  compose,
  activity,
  footer,
}: {
  connections: ReactNode;
  compose: ReactNode;
  activity: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-6 py-8">
        <header className="flex items-center justify-between gap-8">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
              OmniPost
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Self-hosted upload pipeline.
            </p>
          </div>
          <section aria-label="Connection health" className="min-w-0 flex-1">
            {connections}
          </section>
        </header>

        <div className="grid grid-cols-2 items-start gap-6">
          <section aria-label="Compose upload" className="min-w-0">
            {compose}
          </section>
          <section aria-label="Upload activity" className="min-w-0">
            {activity}
          </section>
        </div>

        {footer}
      </main>
    </div>
  );
}

function healthFor(
  platform: ConnectablePlatform,
  connections: ConnectionsView,
): { text: string; dot: string; urgent: boolean } {
  const state = connections[platform];
  if (state.phase === "loading") {
    return { text: "Checking…", dot: "bg-zinc-400", urgent: false };
  }
  if (state.phase === "unavailable") {
    return { text: "Check failed", dot: "bg-amber-500", urgent: false };
  }
  if (!state.status.connected) {
    return { text: "Not connected", dot: "bg-zinc-400", urgent: false };
  }
  if (state.status.reconnectNeeded) {
    return { text: "Action required: reconnect", dot: "bg-red-600", urgent: true };
  }
  const account = state.status.externalAccountLabel
    ?? state.status.externalAccountId
    ?? "Connected";
  return {
    text: platform === "instagram" ? `@${account.replace(/^@/, "")}` : account,
    dot: "bg-emerald-500",
    urgent: false,
  };
}

export function ConnectionStrip({
  connections,
  onDisconnect,
}: {
  connections: ConnectionsView;
  onDisconnect: (platform: ConnectablePlatform) => void | Promise<void>;
}) {
  return (
    <div className="flex justify-end gap-2">
      {CONNECTABLE_PLATFORMS.map((platform) => {
        const label = PLATFORM_LABEL[platform];
        const state = connections[platform];
        const connection = connectionOf(state);
        const health = healthFor(platform, connections);
        return (
          <details
            key={platform}
            className={`relative rounded-full border bg-white text-sm dark:bg-zinc-950 ${
              health.urgent
                ? "border-red-500 ring-2 ring-red-200 dark:ring-red-950"
                : "border-zinc-200 dark:border-zinc-800"
            }`}
          >
            <summary
              aria-label={`Manage ${label}`}
              className="flex cursor-pointer list-none items-center gap-2 px-3 py-2"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${health.dot}`} aria-hidden="true" />
              <span className="font-medium text-black dark:text-zinc-50">{label}</span>
              <span className={health.urgent ? "font-semibold text-red-700 dark:text-red-300" : "text-zinc-600 dark:text-zinc-400"}>
                {health.text}
              </span>
            </summary>
            <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
              {state.phase === "loading" ? (
                <p className="text-zinc-600 dark:text-zinc-400">Account status is still loading.</p>
              ) : connection?.connected ? (
                <div className="flex flex-col gap-3">
                  {connection.reconnectNeeded ? (
                    <a
                      href={connectRoute(platform)}
                      className="inline-flex w-fit rounded-md bg-black px-3 py-2 text-white dark:bg-zinc-50 dark:text-black"
                    >
                      Reconnect {label}
                    </a>
                  ) : null}
                  <details>
                    <summary className="cursor-pointer text-red-700 dark:text-red-300">
                      Disconnect
                    </summary>
                    <div className="mt-3 rounded-md bg-red-50 p-3 dark:bg-red-950/30">
                      <p className="font-medium text-black dark:text-zinc-50">
                        Disconnect {health.text}?
                      </p>
                      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                        Posting here will require connecting the account again.
                      </p>
                      <button
                        type="button"
                        onClick={() => void onDisconnect(platform)}
                        className="mt-3 rounded-md bg-red-700 px-3 py-2 text-white"
                      >
                        Yes, disconnect
                      </button>
                    </div>
                  </details>
                </div>
              ) : (
                <a
                  href={connectRoute(platform)}
                  className="inline-flex rounded-md bg-black px-3 py-2 text-white dark:bg-zinc-50 dark:text-black"
                >
                  {state.phase === "unavailable" ? `Reconnect ${label}` : `Connect ${label}`}
                </a>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Checking duration…";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export function VideoPicker({
  file,
  previewUrl,
  durationSeconds,
  dragging,
  onDragStateChange,
  onSelect,
  onRemove,
  onDurationChange,
}: {
  file: File | null;
  previewUrl: string | null;
  durationSeconds: number | null;
  dragging: boolean;
  onDragStateChange: (dragging: boolean) => void;
  onSelect: (file: File) => void;
  onRemove: () => void;
  onDurationChange?: (seconds: number) => void;
}) {
  function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    onDragStateChange(false);
    const selected = event.dataTransfer.files[0];
    if (selected) onSelect(selected);
  }

  if (!file) {
    return (
      <label
        onDragOver={(event) => {
          event.preventDefault();
          onDragStateChange(true);
        }}
        onDragLeave={() => onDragStateChange(false)}
        onDrop={drop}
        className={`mx-auto flex aspect-[9/16] max-h-[240px] w-full max-w-[180px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-5 text-center text-sm transition-colors ${
          dragging
            ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-900"
            : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950"
        }`}
      >
        <input
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(event) => {
            const selected = event.target.files?.[0];
            if (selected) onSelect(selected);
          }}
        />
        <span className="font-medium text-black dark:text-zinc-50">
          Drop a vertical video here
        </span>
        <span className="mt-1 text-zinc-500 dark:text-zinc-400">or click to choose</span>
      </label>
    );
  }

  return (
    <figure className="relative mx-auto max-w-[180px] overflow-hidden rounded-xl border border-zinc-200 bg-black dark:border-zinc-800">
      {previewUrl ? (
        <video
          controls
          src={previewUrl}
          onLoadedMetadata={(event) => onDurationChange?.(event.currentTarget.duration)}
          className="aspect-[9/16] max-h-[240px] w-full object-contain"
        />
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/80 text-xl text-white"
      >
        ×
      </button>
      <figcaption className="flex items-center justify-between gap-3 bg-white px-3 py-2 text-xs dark:bg-zinc-950">
        <span className="truncate font-medium text-black dark:text-zinc-50">{file.name}</span>
        <span className="shrink-0 text-zinc-500 dark:text-zinc-400">
          {(file.size / (1024 * 1024)).toFixed(1)} MB · {formatDuration(durationSeconds)}
        </span>
      </figcaption>
    </figure>
  );
}
