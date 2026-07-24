import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("GET /api/uploads/[id]", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-upload-status-"));
    const dbPath = path.join(dir, "test.db");
    writeFileSync(dbPath, "");
    process.env.DATABASE_URL = `file:${dbPath}`;

    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 404 for an unknown upload", async () => {
    const { GET } = await import("@/app/api/uploads/[id]/route");

    const response = await GET(new Request("http://localhost/api/uploads/missing"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(response.status).toBe(404);
  });

  it("reports job status for an existing upload", async () => {
    const { GET } = await import("@/app/api/uploads/[id]/route");
    const { prisma, ensureSeedUser } = await import("@/lib/db");

    const user = await ensureSeedUser();
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "My Short",
        description: "A short clip",
        fileName: "clip.mp4",
        filePath: "/tmp/clip.mp4",
        fileSize: 1024,
        jobs: { create: [{ platform: "dry-run", status: "done", resultUrl: "dry-run://x" }] },
      },
    });

    const response = await GET(
      new Request(`http://localhost/api/uploads/${upload.id}`),
      { params: Promise.resolve({ id: upload.id }) },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(upload.id);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].status).toBe("done");
    expect(data.jobs[0].resultUrl).toBe("dry-run://x");
  });
});
