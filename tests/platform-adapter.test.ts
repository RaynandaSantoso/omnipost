import { describe, expect, it } from "vitest";
import { DryRunAdapter } from "@/lib/adapters/dry-run-adapter";
import { YouTubeAdapter } from "@/lib/adapters/youtube-adapter";
import { TikTokAdapter } from "@/lib/adapters/tiktok-adapter";
import { getAdapter } from "@/lib/adapters/registry";

describe("DryRunAdapter", () => {
  it("resolves a result url with no outbound network call", async () => {
    const adapter = new DryRunAdapter();

    const result = await adapter.upload({
    title: "My Short",
    description: "A short clip",
    filePath: "/tmp/clip.mp4",
    userId: "user-1",
    });

    expect(result.url).toBe("dry-run://My%20Short");
  });
});

describe("getAdapter", () => {
  it("returns the dry-run adapter for the dry-run platform", () => {
    expect(getAdapter("dry-run")).toBeInstanceOf(DryRunAdapter);
  });

  it("returns the YouTube adapter for YouTube", () => {
    expect(getAdapter("youtube")).toBeInstanceOf(YouTubeAdapter);
  });

  it("returns the TikTok adapter for TikTok", () => {
    expect(getAdapter("tiktok")).toBeInstanceOf(TikTokAdapter);
  });

  it("throws for an unregistered platform", () => {
    expect(() => getAdapter("instagram")).toThrow(
      /no adapter registered for platform "instagram"/,
    );
  });
});
