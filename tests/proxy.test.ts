import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/session";

function isPassthrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

function requestFor(path: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
  }
  return new NextRequest(new URL(path, "http://localhost"), { headers });
}

describe("proxy access gate", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "file:./dev.db";
  });

  it("passes every request through when no password is configured", async () => {
    delete process.env.ACCESS_PASSWORD;
    resetConfigCache();
    const { proxy } = await import("@/proxy");

    const response = proxy(requestFor("/dashboard"));

    expect(isPassthrough(response)).toBe(true);
  });

  describe("with a password configured", () => {
    beforeEach(() => {
      process.env.ACCESS_PASSWORD = "correct horse";
      resetConfigCache();
    });

    it("redirects an unauthenticated page request to /login", async () => {
      const { proxy } = await import("@/proxy");

      const response = proxy(requestFor("/dashboard"));

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("next")).toBe("/dashboard");
    });

    it("rejects an unauthenticated API request with 401 JSON", async () => {
      const { proxy } = await import("@/proxy");

      const response = proxy(requestFor("/api/uploads"));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    });

    it("exempts only the signed media route beneath an upload", async () => {
      const { proxy } = await import("@/proxy");

      expect(
        isPassthrough(
          proxy(requestFor("/api/uploads/upload-123/file?token=signed-value")),
        ),
      ).toBe(true);
      expect(proxy(requestFor("/api/uploads/upload-123")).status).toBe(401);
      expect(proxy(requestFor("/api/uploads/upload-123/jobs")).status).toBe(401);
    });

    it("leaves the login page and its API reachable without a session", async () => {
      const { proxy } = await import("@/proxy");

      expect(isPassthrough(proxy(requestFor("/login")))).toBe(true);
      expect(isPassthrough(proxy(requestFor("/api/auth/login")))).toBe(true);
    });

    it("leaves the health check reachable without a session", async () => {
      const { proxy } = await import("@/proxy");

      expect(isPassthrough(proxy(requestFor("/api/health")))).toBe(true);
    });

    it("leaves legal pages and the TikTok verification file publicly reachable", async () => {
      const { proxy } = await import("@/proxy");

      expect(isPassthrough(proxy(requestFor("/terms")))).toBe(true);
      expect(isPassthrough(proxy(requestFor("/privacy")))).toBe(true);
      expect(
        isPassthrough(
          proxy(requestFor("/tiktokgViPYSrytG8FdpTMZoWIQFW1rRLGPKAM.txt")),
        ),
      ).toBe(true);
    });

    it("admits a request carrying a valid session and renews the cookie", async () => {
      const { proxy } = await import("@/proxy");
      const token = createSessionToken("correct horse");

      const response = proxy(requestFor("/dashboard", token));

      expect(isPassthrough(response)).toBe(true);
      const renewed = response.cookies.get(SESSION_COOKIE_NAME);
      expect(renewed).toBeDefined();
      const [originalExpiry] = token.split(".");
      const [renewedExpiry] = renewed!.value.split(".");
      expect(Number(renewedExpiry)).toBeGreaterThanOrEqual(Number(originalExpiry));
    });

    it("rejects a tampered session cookie like no session at all", async () => {
      const { proxy } = await import("@/proxy");

      const response = proxy(requestFor("/dashboard", "garbage.value"));

      expect(response.status).toBe(307);
    });
  });
});
