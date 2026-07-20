import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("GET /api/health", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-health-"));
    const dbPath = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${dbPath}`;

    // Exercise the real migration files against a throwaway db, same as
    // what runs at boot, rather than faking schema sync.
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports ok when the database is reachable", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      database: "ok",
    });
  });

  it("reports 503 when the database is unreachable", async () => {
    const { GET } = await import("@/app/api/health/route");
    const { prisma } = await import("@/lib/db");
    const querySpy = vi
      .spyOn(prisma, "$queryRaw")
      .mockRejectedValueOnce(new Error("database is unreachable"));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      database: "unreachable",
    });

    querySpy.mockRestore();
  });
});
