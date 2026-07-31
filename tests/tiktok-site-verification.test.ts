import { describe, expect, it } from "vitest";
import { GET } from "@/app/tiktokgViPYSrytG8FdpTMZoWIQFW1rRLGPKAM.txt/route";

describe("TikTok site verification", () => {
  it("serves the exact signature TikTok supplied", async () => {
    const response = GET();

    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    await expect(response.text()).resolves.toBe(
      "tiktok-developers-site-verification=gViPYSrytG8FdpTMZoWIQFW1rRLGPKAM",
    );
  });
});
