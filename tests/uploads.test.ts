import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function uploadRequest(fields: {
  video?: File | null;
  title?: string;
  description?: string;
}) {
  const body = new FormData();
  if (fields.video !== undefined && fields.video !== null) {
    body.set("video", fields.video);
  }
  if (fields.title !== undefined) {
    body.set("title", fields.title);
  }
  if (fields.description !== undefined) {
    body.set("description", fields.description);
  }
  return new Request("http://localhost/api/uploads", {
    method: "POST",
    body,
  });
}

describe("POST /api/uploads", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-uploads-"));
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

  it("creates an Upload and a pending Job, returning immediately", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { prisma } = await import("@/lib/db");

    const video = new File(["fake video bytes"], "clip.mp4", {
      type: "video/mp4",
    });

    const response = await POST(
      uploadRequest({ video, title: "My Short", description: "A short clip" }),
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].status).toBe("pending");
    expect(data.jobs[0].platform).toBe("dry-run");

    const upload = await prisma.upload.findUnique({
      where: { id: data.id },
      include: { jobs: true },
    });
    expect(upload?.title).toBe("My Short");
    expect(upload?.description).toBe("A short clip");
    expect(upload?.fileName).toBe("clip.mp4");
    expect(upload?.jobs).toHaveLength(1);
    expect(upload?.jobs[0].status).toBe("pending");
  });

  it("rejects a request with no video file", async () => {
    const { POST } = await import("@/app/api/uploads/route");

    const response = await POST(
      uploadRequest({ title: "My Short", description: "A short clip" }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a request with no title", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const video = new File(["fake video bytes"], "clip.mp4", {
      type: "video/mp4",
    });

    const response = await POST(
      uploadRequest({ video, title: "", description: "A short clip" }),
    );

    expect(response.status).toBe(400);
  });
});
