import { beforeEach, describe, expect, it } from "vitest";
import { LOCAL_ONLY_ENV_VAR, resetConfigCache } from "@/lib/config";
import { createPublicMediaUrl } from "@/lib/public-media";

describe("public media URLs in a local-only run", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "file:./dev.db";
    process.env.PUBLIC_BASE_URL = "https://omnipost.ngrok-free.app";
    process.env.ACCESS_PASSWORD = "correct horse battery staple";
    process.env[LOCAL_ONLY_ENV_VAR] = "1";
    resetConfigCache();
  });

  it("refuses to mint a URL for an origin that this run is not serving", () => {
    expect(() => createPublicMediaUrl("upload-123")).toThrow(/Local-only run/);
  });
});
