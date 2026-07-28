import { describe, expect, it } from "vitest";
import { platformSchema } from "@/lib/platform";

describe("platformSchema", () => {
  it("accepts every currently-registered platform", () => {
    expect(platformSchema.safeParse("dry-run").success).toBe(true);
    expect(platformSchema.safeParse("youtube").success).toBe(true);
  });

  it("rejects an unregistered platform value", () => {
    const result = platformSchema.safeParse("tiktok");
    expect(result.success).toBe(false);
  });
});
