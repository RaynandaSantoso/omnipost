import { describe, expect, it } from "vitest";
import { resolveJobMetadata } from "@/lib/job-metadata";

describe("resolveJobMetadata", () => {
  it("falls back to the Upload's shared text when a Job has no overrides", () => {
    expect(resolveJobMetadata(
      { platform: "youtube", titleOverride: null, descriptionOverride: null },
      { title: "Shared title", description: "Shared description" },
    )).toEqual({
      title: "Shared title",
      description: "Shared description",
    });
  });

  it("applies one Job's overrides without changing a sibling Job", () => {
    const upload = { title: "Shared title", description: "Shared description" };

    expect(resolveJobMetadata(
      {
        platform: "youtube",
        titleOverride: "YouTube title",
        descriptionOverride: "YouTube description",
      },
      upload,
    )).toEqual({
      title: "YouTube title",
      description: "YouTube description",
    });
    expect(resolveJobMetadata(
      { platform: "instagram", titleOverride: null, descriptionOverride: null },
      upload,
    )).toEqual(upload);
  });

  it("treats a caption override as finished outbound text", () => {
    expect(resolveJobMetadata(
      {
        platform: "tiktok",
        titleOverride: "A finished TikTok caption #shorts",
        descriptionOverride: null,
      },
      { title: "Shared title", description: "Shared description" },
    )).toEqual({
      title: "A finished TikTok caption #shorts",
      description: "",
    });
  });
});
