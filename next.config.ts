import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
