# Architecture and code map

OmniPost is a single-operator Next.js application with a React dashboard,
SQLite through Prisma, local video storage, and a background Job runner in the
server process. It does not require a separate queue service. Start with the
[README](../README.md) to run it and [CONTEXT.md](../CONTEXT.md) for terminology.

## From upload to platform result

1. The [dashboard](../src/app/page.tsx) loads platform connection statuses and
   lets the operator select destinations and edit shared or per-platform text.
   Connection loading must finish before deriving platform-specific limits.
2. [POST /api/uploads](../src/app/api/uploads/route.ts) parses the request.
   [uploads.ts](../src/lib/uploads.ts) validates target connections, file policy,
   and composed metadata, stores the video, and creates an Upload with one Job
   per target. Without an explicit target list, all connected platforms are
   used; with no connections, the fallback is `dry-run`. An explicit empty list
   is rejected.
3. [job-runner.ts](../src/lib/job-runner.ts) polls for work.
   [job-engine.ts](../src/lib/job-engine.ts) claims a Job with a Lease and
   snapshots its Resolved metadata. Subsequent edits affect later attempts.
4. The [adapter registry](../src/lib/adapters/registry.ts) selects a
   [PlatformAdapter](../src/lib/platform-adapter.ts). Each adapter owns its
   provider's upload protocol; the engine owns attempts, Leases, and retry policy.
5. The adapter result or failure updates the Job. The dashboard polls status;
   one platform can fail while another succeeds for the same Upload.

[platform-upload-policy.ts](../src/lib/platform-upload-policy.ts) owns file and
text limits; [job-metadata.ts](../src/lib/job-metadata.ts) resolves inherited
text, overrides, and hashtags. Limits apply to the composed result for every
target, not just fields with overrides. Null overrides inherit shared values;
an explicit empty hashtag list replaces shared hashtags. For caption-only
platforms, an authored caption override is already composed, so resolution
clears the separate description instead of appending it again.

## Persistence, boot, and recovery

The [Prisma schema](../prisma/schema.prisma) defines User, PlatformConnection,
OAuthState, Upload, and Job. User is currently one seeded identity; this is not
multi-user authentication. Domain ownership is retained in the schema to make future multi-user work
additive; it does not provide user isolation by itself. Lease and Transfer state
are Job fields rather than separate entities. Transfer byte offsets use BigInt
so they can represent videos beyond a signed 32-bit offset.

Platform values are application-validated strings
([ADR-0002](adr/0002-generalize-platform-connection-schema.md)).

[src/instrumentation.ts](../src/instrumentation.ts) validates configuration,
applies checked-in migrations, ensures the seeded User, checks credential-key
availability, backfills older YouTube labels, installs shutdown handlers, and
recovers stalled Jobs before starting the runner. A startup failure exits the
server instead of leaving a partially initialized instance serving requests.

[storage.ts](../src/lib/storage.ts) stores videos in an `uploads/` directory
beside the SQLite file selected by `DATABASE_URL`. Relative database paths
resolve from the app's working directory. Docker places both under `/app/data`.
The database contains encrypted credentials and Job history; video files must
also persist. Preserve both together, and keep `TOKEN_ENCRYPTION_KEY` available
separately so stored credentials remain readable.

Expired Job Leases permit recovery after a crash. Heartbeats renew active
claims; writes are guarded by Lease ownership. Retryable failures use bounded
exponential backoff with jitter. Terminal failures wait for operator action.
YouTube persists resumable upload state and queries the remote byte offset
before continuing through [VideoFile](../src/lib/video-file.ts). TikTok and
Instagram do not implement that resumable protocol. An interrupted or uncertain
external post is not a guarantee of duplicate-free retry.

## Connections and access boundaries

The `*-oauth.ts` modules in `src/lib/` own provider authorization, account
identity, token refresh, and reconnect status. API connection responses expose
status and labels, never tokens. [token-crypto.ts](../src/lib/token-crypto.ts)
encrypts credentials with AES-256-GCM. Instagram Login uses a professional
Instagram account directly; its single renewable token is stored in both token
columns to fit the common connection shape. No Facebook Page is modeled.

[src/proxy.ts](../src/proxy.ts) applies the shared-password access gate, with
public exceptions for login, health, legal pages, provider verification, and
signed media. [public-media.ts](../src/lib/public-media.ts) issues one-hour,
upload-scoped HMAC authorization URLs so Instagram can fetch video bytes without
a session cookie. The encryption key also supplies a domain-separated media
signing key; changing it invalidates existing credentials and signed URLs.

## Runtime ownership

[ADR-0004](adr/0004-operator-machine-is-the-host.md) explains the primary macOS
runtime. [scripts/launcher/lifecycle.mjs](../scripts/launcher/lifecycle.mjs)
owns preflight, production builds, app health checks, the ngrok tunnel, and
idle-sleep prevention. The terminal adapter is
[scripts/launch.mjs](../scripts/launch.mjs); the native application in
[macos/OmniPostLauncher.swift](../macos/OmniPostLauncher.swift) uses the
[menu-bar bridge and controller](../scripts/menu-bar/controller.mjs).

The Launcher claims ownership before preflight through an atomic per-user
record. Supervisor and owned process-group identities include operating-system
start times to avoid confusing reused process IDs with owned processes.
Running requires both a verified supervisor and app health. Recovery cleans up
verified owned groups before replacing stale ownership; an uncleaned survivor
remains a reported failure. It never finds processes by command name.

The Launcher builds when no usable build exists; use `--rebuild` after changing
code if a build already exists. Stop drains work and cleans up companion
processes. Interactive timeouts offer waiting or explicit force stop; system
termination uses bounded cleanup and then forces verified owned groups if
needed. Session logs redact known configured secrets before output is retained.
See the README for locations, commands, and status exit codes.

Development launchers (`scripts/dev-all.mjs` and `scripts/dev-app.mjs`) are
separate from production ownership. Docker starts the app directly and relies
on its host for routing, TLS, and process supervision.

## Where changes belong

| Area | Main files | Relevant tests |
| --- | --- | --- |
| Dashboard and selection | `src/app/page.tsx`, `src/hooks/`, `src/components/` | `tests/dashboard-*.test.ts` |
| Upload validation and text | `src/lib/uploads.ts`, `src/lib/job-metadata.ts`, `src/lib/platform-upload-policy.ts` | Upload, metadata, and policy tests |
| Background execution | `src/lib/job-engine.ts`, `src/lib/job-runner.ts`, `src/lib/shutdown.ts` | Job engine and runner tests |
| Provider integration | `src/lib/adapters/`, `src/lib/*-oauth.ts`, `src/app/api/platforms/` | Provider OAuth and adapter tests |
| Runtime and menu bar | `scripts/launcher/`, `scripts/menu-bar/`, `macos/` | `tests/production-launcher.test.ts`, `tests/menu-bar-launcher.test.ts` |

See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, checks, and documentation
conventions. Local planning documents are not required to understand shipped
behavior.
