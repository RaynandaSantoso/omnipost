import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { resolveDatabaseUrl } from "@/lib/database-url";

describe("runMigrations", () => {
  let dir: string;
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-migrate-"));
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies migrations to a fresh database, creating the schema tables", async () => {
    const { runMigrations } = await import("@/lib/migrate");

    expect(() => runMigrations()).not.toThrow();

    const adapter = new PrismaBetterSqlite3({
      url: resolveDatabaseUrl(process.env.DATABASE_URL!),
    });
    const client = new PrismaClient({ adapter });
    try {
      await expect(client.user.findMany()).resolves.toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });
});
