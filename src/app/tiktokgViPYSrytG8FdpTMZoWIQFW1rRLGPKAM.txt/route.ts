const VERIFICATION =
  "tiktok-developers-site-verification=gViPYSrytG8FdpTMZoWIQFW1rRLGPKAM";

export function GET() {
  return new Response(VERIFICATION, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
