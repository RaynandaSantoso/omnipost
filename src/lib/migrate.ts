import { execFileSync } from "node:child_process";

// Applies any pending migrations against DATABASE_URL. Run once at server
// boot so "upgrade" is just "pull a new image and restart" — no manual
// migration step for the operator.
export function runMigrations(): void {
  execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: process.env,
  });
}
