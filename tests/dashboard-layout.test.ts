import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ConnectionStrip,
  DashboardShell,
  VideoPicker,
} from "@/components/dashboard-shell";
import { OutboundTextPreview, UploadActivityList } from "@/app/page";
import {
  connectionLoaded,
  connectionLoading,
  connectionUnavailable,
  disconnected,
  type ConnectionsView,
} from "@/lib/connection-status";

const connected = (label: string, reconnectNeeded = false) => ({
  connected: true,
  externalAccountId: `${label}-id`,
  externalAccountLabel: label,
  reconnectNeeded,
});

describe("DashboardShell", () => {
  it("renders compose and activity side by side in the desktop workspace", () => {
    const html = renderToStaticMarkup(createElement(DashboardShell, {
      connections: createElement("span", null, "Connections"),
      compose: createElement("span", null, "Composer"),
      activity: createElement("span", null, "Jobs"),
      footer: createElement("span", null, "Footer"),
    }));

    expect(html).toContain('aria-label="Connection health"');
    expect(html).toContain('aria-label="Compose upload"');
    expect(html).toContain('aria-label="Upload activity"');
    expect(html).toContain("grid-cols-2");
    expect(html).not.toContain("max-w-md");
  });
});

describe("ConnectionStrip", () => {
  function render(connections: ConnectionsView) {
    return renderToStaticMarkup(createElement(ConnectionStrip, {
      connections,
      onDisconnect: () => {},
    }));
  }

  it("distinguishes every connection state with text, not colour alone", () => {
    const unavailableAndLoading = render({
      youtube: connectionLoading(),
      tiktok: connectionUnavailable(),
      instagram: connectionLoaded(disconnected()),
    });
    expect(unavailableAndLoading).toContain("Checking…");
    expect(unavailableAndLoading).toContain("Check failed");
    expect(unavailableAndLoading).toContain("Not connected");

    const connectedAndStale = render({
      youtube: connectionLoaded(connected("My Channel")),
      tiktok: connectionLoaded(connected("My TikTok", true)),
      instagram: connectionLoaded(disconnected()),
    });
    expect(connectedAndStale).toContain("My Channel");
    expect(connectedAndStale).toContain("Action required: reconnect");
  });

  it("keeps account actions secondary and asks before disconnecting", () => {
    const html = render({
      youtube: connectionLoaded(connected("My Channel")),
      tiktok: connectionLoaded(disconnected()),
      instagram: connectionLoaded(disconnected()),
    });

    expect(html).toContain("Manage YouTube");
    expect(html).toContain("Disconnect My Channel?");
    expect(html).toContain("Yes, disconnect");
    expect(html).toContain('href="/api/platforms/tiktok/connect"');
  });

  it("does not present TikTok posting policy as connection health", () => {
    const html = render({
      youtube: connectionLoaded(disconnected()),
      tiktok: connectionLoaded(connected("My TikTok")),
      instagram: connectionLoaded(disconnected()),
    });

    expect(html).not.toContain("Videos upload as private");
  });
});

describe("VideoPicker", () => {
  it("renders an in-place video preview with metadata and a remove control", () => {
    const file = { name: "portrait.mp4", size: 12.5 * 1024 * 1024 } as File;
    const html = renderToStaticMarkup(createElement(VideoPicker, {
      file,
      previewUrl: "blob:preview-1",
      durationSeconds: 72.4,
      dragging: false,
      onDragStateChange: () => {},
      onSelect: () => {},
      onRemove: () => {},
    }));

    expect(html).toContain('<video controls=""');
    expect(html).toContain('src="blob:preview-1"');
    expect(html).toContain("portrait.mp4");
    expect(html).toContain("12.5 MB");
    expect(html).toContain("1:12");
    expect(html).toContain('aria-label="Remove portrait.mp4"');
    expect(html).toContain("max-h-[240px]");
    expect(html).not.toContain("max-h-[420px]");
  });

  it("uses the preview column as the dropzone when no file is selected", () => {
    const html = renderToStaticMarkup(createElement(VideoPicker, {
      file: null,
      previewUrl: null,
      durationSeconds: null,
      dragging: false,
      onDragStateChange: () => {},
      onSelect: () => {},
      onRemove: () => {},
    }));

    expect(html).toContain("Drop a vertical video here");
    expect(html).not.toContain("<video");
  });
});

describe("compact outbound preview", () => {
  it("summarizes usage, retains resolved text, and puts TikTok policy by its caption", () => {
    const html = renderToStaticMarkup(createElement(OutboundTextPreview, {
      platforms: ["youtube", "tiktok"],
      title: "My Short",
      description: "A short clip",
      hashtags: ["launch"],
    }));

    expect(html).toContain("title 8/100");
    expect(html).toContain("description 21/5000");
    expect(html).toContain("caption 31/2200");
    expect(html).toContain("Videos upload as private until TikTok approves");
    expect(html).toContain("#launch");
  });

  it("opens a row automatically when its resolved text exceeds a limit", () => {
    const html = renderToStaticMarkup(createElement(OutboundTextPreview, {
      platforms: ["youtube"],
      title: "x".repeat(101),
      description: "",
    }));

    expect(html).toContain("<details open=\"\"");
    expect(html).toContain("101/100");
  });
});

describe("UploadActivityList", () => {
  const upload = (
    id: string,
    createdAt: string,
    statuses: Array<"pending" | "uploading" | "done" | "failed"> = ["uploading", "done", "done"],
  ) => ({
    id,
    title: `${id} title`,
    description: "Shared description",
    hashtags: ["launch"],
    fileName: `${id}.mp4`,
    fileSize: 2048,
    createdAt,
    jobs: ["youtube", "tiktok", "instagram"].map((platform, index) => ({
      id: `${id}-${platform}`,
      platform: platform as "youtube" | "tiktok" | "instagram",
      status: statuses[index],
      resultUrl: null,
      error: null,
      metadataSource: "shared" as const,
      effectiveMetadata: {
        title: platform === "youtube" ? "Shared title" : "Shared title\n\nShared description\n\n#launch",
        description: platform === "youtube" ? "Shared description\n\n#launch" : "",
      },
    })),
  });

  it("expands only the newest upload and keeps older uploads to summary rows", () => {
    const html = renderToStaticMarkup(createElement(UploadActivityList, {
      uploads: [
        upload("new", "2026-08-09T10:00:00.000Z"),
        upload("old", "2026-08-08T10:00:00.000Z"),
      ],
      onRetry: () => {},
      onSaveMetadata: () => {},
    }));

    expect(html.match(/<details open=""/g)).toHaveLength(1);
    expect(html).toContain("new title");
    expect(html).toContain("old title");
    expect(html.match(/aria-label="Shared resolved text"/g)).toHaveLength(2);
    expect(html).not.toContain("#launch\n\n#launch");
    expect(html.match(/aria-label="new upload"/g)).toHaveLength(1);
  });

  it("promotes an in-flight upload above newer settled history", () => {
    const html = renderToStaticMarkup(createElement(UploadActivityList, {
      uploads: [
        upload("new-settled", "2026-08-09T10:00:00.000Z", ["done", "done", "done"]),
        upload("old-running", "2026-08-08T10:00:00.000Z", ["uploading", "done", "done"]),
      ],
      onRetry: () => {},
      onSaveMetadata: () => {},
    }));

    expect(html.indexOf('aria-label="old-running upload"'))
      .toBeLessThan(html.indexOf('aria-label="new-settled upload"'));
    expect(html).toContain('<details open="" aria-label="old-running upload"');
  });
});
