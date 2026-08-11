# ADR-0001: Oracle Cloud Always Free VM + dynamic-DNS domain for deployment

Status: superseded by ADR-0004

The VM was never stood up. The operator's own machine turned out to be the
host, reached through a reserved ngrok domain — see
`0004-operator-machine-is-the-host.md`. The reasoning below about *why*
serverless was rejected still stands and is why ADR-0004 also runs a
persistent process; only the choice of machine changed.

## Context

OmniPost's earlier decision record (see git history / prior session)
already ruled out serverless hosting: the background job runner is a
long-lived process (polls, claims leases, heartbeats), SQLite and
uploaded video files need to persist on disk between requests, and a real
video upload can run for minutes — all incompatible with a functions
platform. Vercel was evaluated and rejected on exactly these grounds.

That leaves persistent-process hosts. The operator wants the entire stack,
including hosting, at $0 ongoing cost.

## Decision

**Host on an Oracle Cloud Always Free VM**, specifically the AMD-based
`VM.Standard.E2.1.Micro` shape rather than the ARM Ampere A1 shape — Ampere
A1 is also part of Always Free but is frequently unavailable ("out of
capacity") in popular regions for new signups, while the AMD micro shape
provisions reliably. The existing Dockerfile/docker-compose.yml run
directly on the VM via `docker compose up`, unchanged from the local
self-host path.

**Domain: a free dynamic-DNS subdomain** (DuckDNS-style), not a purchased
domain. This is IaaS, not a PaaS — Oracle gives a bare public IP, no
bundled subdomain the way Fly.io/Railway/Vercel provide. A real domain
would look more credible on TikTok's/Meta's app-review forms, but was
explicitly traded away to keep total cost at $0.

## Consequences

- The operator manages the box directly: OS updates, Docker installation,
  a reverse proxy for TLS termination (Caddy is the natural fit for
  automatic Let's Encrypt certs from a single Caddyfile) — none of that
  is handled by a managed platform.
- `YOUTUBE_REDIRECT_URI` (and future TikTok/Instagram callback URLs) must
  point at the dynamic-DNS hostname, not `localhost` — every OAuth app
  registration needs updating once this deploy lands.
- `ACCESS_PASSWORD` becomes non-optional in practice: the instance is
  reachable off `localhost` the moment this ships.
- Oracle's Always Free tier has a documented history of reclaiming
  instances flagged as idle/low-utilization, and some users report
  card-verification holds despite $0 billing. Accepted as a known
  operational risk for a low-traffic personal tool, not a security
  concern.
- Revisit if: the VM gets reclaimed repeatedly, the AMD shape's 1GB RAM
  becomes a real constraint, or the operator later wants the more
  polished ops experience (custom domain, zero-config TLS/volumes) a
  paid PaaS would give.
