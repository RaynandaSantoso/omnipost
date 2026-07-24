import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { resolveDatabaseUrl } from "@/lib/database-url";

// Applies any pending migrations against DATABASE_URL. Run once at server
// boot so "upgrade" is just "pull a new image and restart" — no manual
// migration step for the operator.
export function runMigrations(): void {
  const url = resolveDatabaseUrl(process.env.DATABASE_URL ?? "file:./data/dev.db");
  const filePath = url.slice("file:".length);
  if (filePath !== ":memory:") {
    mkdirSync(path.dirname(filePath), { recursive: true });
    closeSync(openSync(filePath, "a"));
  }
  execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: process.env,
  });
}
