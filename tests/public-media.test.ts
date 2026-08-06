import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { JOB_POLICY_DEFAULTS } from "@/lib/job-policy";

const publicOrigin = "https://omnipost.ngrok-free.app";

// The spawned server reads its whole configuration from the environment, and
// Next fills in anything the environment leaves undefined from the operator's
// .env in the project directory. Both are ambient state this test must not
// inherit: an operator whose .env points INSTAGRAM_REDIRECT_URI at a tunnel
// other than the origin below fails the config's cross-validation, and the
// server never boots. So every variable the config schema reads gets a value
// chosen here — including the platforms this test never touches — and the
// parent process is pinned to the same values so the signing key and public
// origin cannot diverge between the two.
function configEnvironment(databasePath: string): Record<string, string> {
  return {
    DATABASE_URL: `file:${databasePath}`,
    ACCESS_PASSWORD: "shared test password",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    JOB_MAX_ATTEMPTS: String(JOB_POLICY_DEFAULTS.maxAttempts),
    JOB_LEASE_MS: String(JOB_POLICY_DEFAULTS.leaseMs),
    JOB_BACKOFF_BASE_MS: String(JOB_POLICY_DEFAULTS.backoffBaseMs),
    JOB_BACKOFF_MAX_MS: String(JOB_POLICY_DEFAULTS.backoffMaxMs),
    PUBLIC_BASE_URL: publicOrigin,
    YOUTUBE_CLIENT_ID: "test-youtube-client-id",
    YOUTUBE_CLIENT_SECRET: "test-youtube-client-secret",
    YOUTUBE_REDIRECT_URI: `${publicOrigin}/api/platforms/youtube/callback`,
    TIKTOK_CLIENT_KEY: "test-tiktok-client-key",
    TIKTOK_CLIENT_SECRET: "test-tiktok-client-secret",
    TIKTOK_REDIRECT_URI: `${publicOrigin}/api/platforms/tiktok/callback`,
    INSTAGRAM_APP_ID: "test-instagram-app-id",
    INSTAGRAM_APP_SECRET: "test-instagram-app-secret",
    INSTAGRAM_REDIRECT_URI: `${publicOrigin}/api/platforms/instagram/callback`,
  };
}

// Built rather than spread from process.env: only what a Node child needs to
// run at all is passed through, so nothing outside configEnvironment can
// reach the server.
function childEnvironment(config: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    ...config,
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

describe("public upload media route", () => {
  let directory: string;
  let app: ChildProcess;
  let appOrigin: string;
  let appOutput = "";

  function throughApp(publicUrl: URL): string {
    return new URL(`${publicUrl.pathname}${publicUrl.search}`, appOrigin).href;
  }

  async function createStoredUpload(fileName = "creator clip.mp4") {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const user = await ensureSeedUser();
    const filePath = path.join(directory, `${crypto.randomUUID()}.mp4`);
    const videoBytes = Buffer.from("exact video bytes");
    writeFileSync(filePath, videoBytes);
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "Public clip",
        description: "",
        fileName,
        filePath,
        fileSize: videoBytes.length,
      },
    });
    return { upload, videoBytes };
  }

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "omnipost-public-media-"));
    const databasePath = path.join(directory, "test.db");
    writeFileSync(databasePath, "");
    const config = configEnvironment(databasePath);
    Object.assign(process.env, config);
    resetConfigCache();

    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: childEnvironment(config),
    });

    const port = await availablePort();
    appOrigin = `http://127.0.0.1:${port}`;
    app = spawn(
      process.execPath,
      ["node_modules/next/dist/bin/next", "dev", "-p", String(port)],
      {
        cwd: process.cwd(),
        env: childEnvironment(config),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    app.stdout?.on("data", (chunk) => (appOutput += chunk.toString()));
    app.stderr?.on("data", (chunk) => (appOutput += chunk.toString()));

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (app.exitCode !== null) {
        throw new Error(`Next test server exited before startup:\n${appOutput}`);
      }
      try {
        const response = await fetch(`${appOrigin}/api/health`);
        if (response.ok) return;
      } catch {
        // The port is not accepting requests yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out starting Next test server:\n${appOutput}`);
  }, 40_000);

  afterAll(async () => {
    if (app && app.exitCode === null) {
      app.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        app.once("exit", () => resolve());
        setTimeout(resolve, 5_000);
      });
    }
    rmSync(directory, { recursive: true, force: true });
  }, 10_000);

  it("serves the exact stored bytes for a valid signed URL", async () => {
    const { createPublicMediaUrl } = await import("@/lib/public-media");
    const { upload, videoBytes } = await createStoredUpload();
    const generatedAt = Date.now();
    const publicUrl = createPublicMediaUrl(upload.id);

    expect(publicUrl.origin).toBe(publicOrigin);
    expect(publicUrl.pathname).toBe(`/api/uploads/${upload.id}/file`);
    const token = publicUrl.searchParams.get("token")!;
    expect(token).toMatch(/^v1\./);
    const expiresAt = Number(token.split(".")[1]);
    expect(expiresAt).toBeGreaterThanOrEqual(generatedAt + 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);

    const response = await fetch(throughApp(publicUrl));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(String(videoBytes.length));
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(videoBytes);

    const protectedResponse = await fetch(`${appOrigin}/api/uploads/${upload.id}`);
    expect(protectedResponse.status).toBe(401);
  });

  it("returns 404 for a tampered authorization value", async () => {
    const { createPublicMediaUrl } = await import("@/lib/public-media");
    const { upload } = await createStoredUpload();
    const publicUrl = createPublicMediaUrl(upload.id);
    const token = publicUrl.searchParams.get("token")!;
    publicUrl.searchParams.set("token", `${token.slice(0, -43)}${"A".repeat(43)}`);

    const response = await fetch(throughApp(publicUrl));

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(upload.filePath);
  });

  it("returns 404 for an expired authorization value", async () => {
    const { createPublicMediaUrl } = await import("@/lib/public-media");
    const { upload } = await createStoredUpload();
    const expiredUrl = createPublicMediaUrl(upload.id, 0);

    const response = await fetch(throughApp(expiredUrl));

    expect(response.status).toBe(404);
  });

  it("returns 404 for malformed or missing authorization", async () => {
    const { upload } = await createStoredUpload();
    const routeUrl = `${appOrigin}/api/uploads/${upload.id}/file`;

    const malformed = await fetch(`${routeUrl}?token=not-a-token`);
    const missing = await fetch(routeUrl);

    expect(malformed.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it("does not authorize a different upload with a valid token", async () => {
    const { createPublicMediaUrl } = await import("@/lib/public-media");
    const first = await createStoredUpload();
    const second = await createStoredUpload();
    const firstUrl = createPublicMediaUrl(first.upload.id);
    const token = firstUrl.searchParams.get("token")!;
    const wrongUploadUrl = new URL(
      `/api/uploads/${second.upload.id}/file?token=${encodeURIComponent(token)}`,
      "https://host-from-request.example",
    );

    const response = await fetch(throughApp(wrongUploadUrl));

    expect(response.status).toBe(404);
  });
});
