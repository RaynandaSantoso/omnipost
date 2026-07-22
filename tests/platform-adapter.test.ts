import { describe, expect, it } from "vitest";
import { DryRunAdapter } from "@/lib/adapters/dry-run-adapter";
import { getAdapter } from "@/lib/adapters/registry";

describe("DryRunAdapter", () => {
  it("resolves a result url with no outbound network call", async () => {
    const adapter = new DryRunAdapter();

    const result = await adapter.upload({
      title: "My Short",
      description: "A short clip",
      filePath: "/tmp/clip.mp4",
    });

    expect(result.url).toBe("dry-run://My%20Short");
  });
});

describe("getAdapter", () => {
  it("returns the dry-run adapter for the dry-run platform", () => {
    expect(getAdapter("dry-run")).toBeInstanceOf(DryRunAdapter);
  });

  it("throws for an unregistered platform", () => {
    expect(() => getAdapter("youtube")).toThrow(
      /no adapter registered for platform "youtube"/,
    );
  });
});
