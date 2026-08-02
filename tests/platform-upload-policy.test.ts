import { describe, expect, it } from "vitest";
import {
  composeCaption,
  outboundTextFor,
  uploadPolicyFor,
} from "@/lib/platform-upload-policy";

describe("platform text policy", () => {
  it("declares the text shape and documented limits for every Platform", () => {
    expect(uploadPolicyFor("dry-run").text).toMatchObject({
      kind: "title-and-description",
      titleMaxLength: null,
      descriptionMaxLength: null,
    });
    expect(uploadPolicyFor("youtube").text).toMatchObject({
      kind: "title-and-description",
      titleMaxLength: 100,
      descriptionMaxLength: 5_000,
    });
    expect(uploadPolicyFor("tiktok").text).toMatchObject({
      kind: "caption",
      captionMaxLength: 2_200,
    });
    expect(uploadPolicyFor("instagram").text).toMatchObject({
      kind: "caption",
      captionMaxLength: 2_200,
    });
  });

  it.each([
    ["Title", "Description", "Title\nDescription"],
    ["Title", "", "Title"],
    ["", "Description", "Description"],
    ["", "", ""],
  ])("composes caption fields with the established newline rule", (title, description, expected) => {
    expect(composeCaption({ title, description })).toBe(expected);
  });

  it("renders title-and-description and caption shapes without platform-specific callers", () => {
    const authored = { title: "My Short", description: "A short clip" };

    expect(outboundTextFor("youtube", authored)).toEqual([
      { key: "title", label: "Title", maxLength: 100, value: "My Short" },
      { key: "description", label: "Description", maxLength: 5_000, value: "A short clip" },
    ]);
    expect(outboundTextFor("tiktok", authored)).toEqual([
      { key: "caption", label: "Caption", maxLength: 2_200, value: "My Short\nA short clip" },
    ]);
    expect(outboundTextFor("instagram", authored)).toEqual([
      { key: "caption", label: "Caption", maxLength: 2_200, value: "My Short\nA short clip" },
    ]);
  });
});
