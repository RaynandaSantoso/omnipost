import path from "node:path";

// Prisma 7's driver adapters resolve relative sqlite paths against
// process.cwd(), while the migrate CLI has historically resolved them
// against the schema file's directory. Resolving to an absolute path
// ourselves, once, sidesteps that mismatch for every caller (CLI and
// runtime client alike) — both are always invoked from the app root.
export function resolveDatabaseUrl(raw: string): string {
  const rawPath = raw.replace(/^file:/, "");
  if (rawPath === ":memory:" || path.isAbsolute(rawPath)) {
    return `file:${rawPath}`;
  }
  return `file:${path.resolve(/* turbopackIgnore: true */ process.cwd(), rawPath)}`;
}
