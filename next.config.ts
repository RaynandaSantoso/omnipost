import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this directory. A git worktree carries its own
  // package-lock.json, so without this Turbopack finds several lockfiles and
  // infers a root — warning on every boot about a choice we can just state.
  turbopack: {
    root: fileURLToPath(new URL(".", import.meta.url)),
  },
  // Uploads go through /api/uploads as a route handler request body, not a
  // Server Action — Next's proxy layer caps that body independently of
  // serverActions.bodySizeLimit. Match the client-side 256MB cap in
  // src/app/page.tsx (MAX_FILE_SIZE_BYTES) so a valid file is never
  // silently truncated before it reaches the route handler.
  experimental: {
    proxyClientMaxBodySize: "256mb",
  },
};

export default nextConfig;
