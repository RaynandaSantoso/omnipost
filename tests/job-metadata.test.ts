import { describe, expect, it } from "vitest";
import { jobMetadataViolation, resolveJobMetadata } from "@/lib/job-metadata";

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

  it("composes the Upload's shared hashtags into the description for a title-and-description platform", () => {
    expect(resolveJobMetadata(
      { platform: "youtube", titleOverride: null, descriptionOverride: null },
      { title: "Shared title", description: "Shared description", hashtags: ["launch", "demo"] },
    )).toEqual({
      title: "Shared title",
      description: "Shared description\n\n#launch #demo",
    });
  });

  it("composes the Upload's shared hashtags inline for a caption platform with no override", () => {
    expect(resolveJobMetadata(
      { platform: "tiktok", titleOverride: null, descriptionOverride: null },
      { title: "Shared title", description: "Shared description", hashtags: ["launch"] },
    )).toEqual({
      title: "Shared title",
      description: "Shared description #launch",
    });
  });

  it("does not append hashtags on top of a finished caption override", () => {
    expect(resolveJobMetadata(
      {
        platform: "tiktok",
        titleOverride: "A finished TikTok caption #shorts",
        descriptionOverride: null,
      },
      { title: "Shared title", description: "Shared description", hashtags: ["launch"] },
    )).toEqual({
      title: "A finished TikTok caption #shorts",
      description: "",
    });
  });

  it("leaves resolved text unchanged when the Upload has no hashtags", () => {
    expect(resolveJobMetadata(
      { platform: "youtube", titleOverride: null, descriptionOverride: null },
      { title: "Shared title", description: "Shared description", hashtags: [] },
    )).toEqual({
      title: "Shared title",
      description: "Shared description",
    });
  });

  it("composes a Job's overridden hashtags instead of the Upload's shared set", () => {
    expect(resolveJobMetadata(
      {
        platform: "youtube",
        titleOverride: null,
        descriptionOverride: null,
        hashtagsOverride: JSON.stringify(["tiktokonly"]),
      },
      { title: "Shared title", description: "Shared description", hashtags: ["launch", "demo"] },
    )).toEqual({
      title: "Shared title",
      description: "Shared description\n\n#tiktokonly",
    });
  });

  it("does not compose hashtags for a Job whose override explicitly clears them to none", () => {
    expect(resolveJobMetadata(
      {
        platform: "youtube",
        titleOverride: null,
        descriptionOverride: null,
        hashtagsOverride: JSON.stringify([]),
      },
      { title: "Shared title", description: "Shared description", hashtags: ["launch"] },
    )).toEqual({
      title: "Shared title",
      description: "Shared description",
    });
  });

  it("leaves a sibling Job's hashtags on the Upload's shared set", () => {
    const upload = { title: "Shared title", description: "Shared description", hashtags: ["launch"] };
    expect(resolveJobMetadata(
      { platform: "instagram", titleOverride: null, descriptionOverride: null },
      upload,
    )).toEqual({
      title: "Shared title",
      description: "Shared description #launch",
    });
  });

  it("does not compose hashtags on top of a finished caption override even with a hashtag override set", () => {
    expect(resolveJobMetadata(
      {
        platform: "tiktok",
        titleOverride: "A finished TikTok caption #shorts",
        descriptionOverride: null,
        hashtagsOverride: JSON.stringify(["ignored"]),
      },
      { title: "Shared title", description: "Shared description", hashtags: ["launch"] },
    )).toEqual({
      title: "A finished TikTok caption #shorts",
      description: "",
    });
  });
});

describe("jobMetadataViolation", () => {
  // A caption platform with no overrides of its own: everything it sends comes
  // from the Upload's shared text.
  const sharedJob = { platform: "tiktok", titleOverride: null, descriptionOverride: null };

  it("rejects a shared hashtag set that overflows the composed caption", () => {
    expect(jobMetadataViolation(sharedJob, {
      title: "Title",
      description: "y".repeat(2_190),
      hashtags: ["overflow"],
    })).toBe("tiktok caption must be 2200 characters or fewer");
  });

  it("accepts the same text once the hashtags that overflowed it are gone", () => {
    expect(jobMetadataViolation(sharedJob, {
      title: "Title",
      description: "y".repeat(2_190),
      hashtags: [],
    })).toBeNull();
  });

  it("rejects a per-Job hashtag override on the same terms", () => {
    expect(jobMetadataViolation(
      { ...sharedJob, hashtagsOverride: JSON.stringify(["overflow"]) },
      { title: "Title", description: "y".repeat(2_190), hashtags: [] },
    )).toBe("tiktok caption must be 2200 characters or fewer");
  });

  it("measures the override in place of the shared set it replaces", () => {
    // The shared set would not fit; this Job is not sending it.
    expect(jobMetadataViolation(
      { ...sharedJob, hashtagsOverride: JSON.stringify([]) },
      { title: "Title", description: "y".repeat(2_190), hashtags: ["overflow"] },
    )).toBeNull();
  });

  it("measures a caption override as the finished caption it is", () => {
    // resolveJobMetadata drops the shared hashtags rather than composing them
    // onto an already-finished caption, so validation must not count them
    // either — otherwise the form rejects text the adapter never sees.
    expect(jobMetadataViolation(
      { ...sharedJob, titleOverride: "Finished caption" },
      { title: "Title", description: "y".repeat(2_190), hashtags: ["overflow"] },
    )).toBeNull();
    expect(jobMetadataViolation(
      { ...sharedJob, titleOverride: "x".repeat(2_201) },
      { title: "", description: "", hashtags: [] },
    )).toBe("tiktok caption must be 2200 characters or fewer");
  });

  it("leaves a title-and-description platform to its own field limits", () => {
    expect(jobMetadataViolation(
      { platform: "youtube", titleOverride: null, descriptionOverride: null },
      { title: "Title", description: "y".repeat(2_190), hashtags: ["overflow"] },
    )).toBeNull();
  });

  it("says nothing about a platform it does not recognise", () => {
    expect(jobMetadataViolation(
      { platform: "facebook", titleOverride: null, descriptionOverride: null },
      { title: "Title", description: "y".repeat(5_000), hashtags: [] },
    )).toBeNull();
  });
});
