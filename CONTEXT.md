# OmniPost domain context

Single-context repo. See `docs/adr/` for the decisions behind these terms.

## Vocabulary

- **User** — a single seeded row (v0.1 is single-tenant). Every domain
  table carries a `userId` so real multi-user support later is additive,
  not a schema rewrite. Not to be confused with the *end viewer* of a
  published video — there is no such concept in this app.
- **Platform** — one destination a video can be published to:
  `dry-run`, `youtube`, and (as they land) `tiktok`, `instagram`. A plain
  string validated at the application layer via a shared Zod/TS union, not
  a database enum — Prisma has no real enum support on SQLite, and
  altering a CHECK constraint later means rebuilding the whole table.
- **PlatformAdapter** — the interface every platform integration
  implements: "upload this video with this metadata using these
  credentials, report progress, return a result or a typed failure."
  Nothing in the job engine or pipeline knows a specific platform exists —
  it only knows this interface. `DryRunAdapter` is a real implementation
  of it (the user-facing dry-run feature), not a test double.
- **PlatformConnection** — one operator's OAuth connection to one
  Platform: encrypted access/refresh tokens, expiry, and identifying
  fields for the connected account (`externalAccountId` — the platform's
  own opaque id — and `externalAccountLabel`, a human-readable handle
  shown in the UI instead of the raw id). The access/refresh pair is
  YouTube's shape, and not every platform has two secrets to put in it:
  Instagram issues one long-lived token that renews itself, so both columns
  hold the same value rather than the schema growing a nullable column for
  one platform's peculiarity. Instagram also connects one professional
  account directly, with no Facebook Page in the model at all.
- **Connectable platform** — a Platform a PlatformConnection can exist for.
  Every Platform except `dry-run`, which publishes nowhere and so has no
  account to link. The dashboard renders one connect/status block per
  connectable platform.
- **Connection status** — the dashboard's read-only view of a
  PlatformConnection: connected or not, whether it needs reconnecting, and
  the identifying fields. Deliberately carries no tokens; it is what
  `GET /api/platforms/<platform>` returns.
- **Connection load state** — how far the dashboard has got in *learning* a
  connection status: loading, loaded, or unavailable (the request failed).
  Distinct from the status itself, because "we have not asked yet" and "we
  asked and the answer was no account" are different facts and the operator
  is owed the difference. Nothing that depends on which platforms are
  connected — which file size and format limits apply, above all — may be
  decided until every connectable platform has left the loading state.
- **Upload** — one user-initiated publish action: the source video file,
  plus the shared title/description defaults for every platform it fans out
  to. A Job may override either value without changing these defaults.
- **Job** — one unit of background work: one Upload to one Platform. An
  Upload fans out to one Job per target platform. Carries `status`,
  `attempts`, `nextAttemptAt`, lease fields (`leaseOwner`,
  `leaseExpiresAt`) that make crash recovery possible, and transfer state
  (`uploadSessionUrl`, `bytesUploaded`).
  It may also carry nullable `titleOverride`/`descriptionOverride` values;
  null means inherit the corresponding shared value from its Upload.
- **Resolved metadata** — the final title/description snapshot supplied to a
  PlatformAdapter after a Job's overrides are combined with its Upload's
  shared defaults. It is captured atomically with the Job claim, so edits made
  while an attempt is uploading apply only when a later attempt is claimed;
  the captured text/source also powers the active-attempt status audit.
  Caption-only overrides are already-finished captions, so resolution clears
  the description instead of composing it a second time.
  Text limits are measured against this resolved result, never against the
  fields an operator typed: hashtags are composed into it and belong to no
  field, so measuring earlier misses them entirely. Both write paths — creating
  an Upload and editing a Job's overrides — validate every target platform, not
  only the ones carrying an override, because an Upload's shared text and
  hashtag set can overflow a caption on their own.
- **Lease** — a time-bounded claim a background worker holds on a Job
  while working it, renewed by heartbeat. An expired lease is what makes
  a job reclaimable after a crash, rather than stuck forever.
- **Transfer state** — how far the platform-side transfer of one Job has
  actually got: the platform's upload session URL and the last byte offset
  it confirmed receiving. Plain columns on Job for the same reason the
  lease fields are — per-job bookkeeping, not an entity worth querying.
  It outlives a failed attempt on purpose, so the next one can resume the
  transfer instead of the job; starting a fresh session clears it. Handed
  to an adapter as a `ResumableTransfer` — the same concept, named for what
  the adapter may do with it.
- **TransferTracker** — the port an adapter reports transfer state to, and
  reads the previous attempt's state from, beside PlatformAdapter. An
  adapter knows its platform's resumable protocol; it does not know the
  offsets it reports end up as Job columns, or that the dashboard turns
  them into a progress bar.
- **Resume-query** — asking the platform how many bytes it actually holds
  before re-sending any (YouTube: a zero-length `PUT` with
  `Content-Range: bytes */<total>`). Its answer outranks the persisted
  offset, which is a fallback for a platform that cannot be reached. A
  session the platform has forgotten is replaced, not retried forever.
- **VideoFile** — a video opened for positioned reads, a window at a time.
  It exists because reading a whole video into memory to upload it is what
  the deployed 1GB VM cannot afford (`docs/adr/0001-…`).
- **Public media URL** — a one-hour, upload-scoped capability URL that lets
  Instagram fetch a stored video through the shared public origin. Its random
  HMAC authorization value and expiry are the access boundary: the media route
  intentionally bypasses the browser password gate, while a raw Upload id is
  never sufficient to retrieve a file.
- **Retryable vs. terminal failure** — the classification an adapter
  attaches to every failure it reports. Retryable (rate limit, 5xx,
  network) gets exponential backoff with jitter, up to an attempt budget.
  Terminal (bad credentials, rejected content, quota exhausted) stops
  immediately and waits for the operator — retrying it would just hammer
  a platform already telling you no.
- **Access gate** — the optional shared-password gate (`ACCESS_PASSWORD`),
  not a user-accounts system. One password, one session cookie, no
  per-user identity. It runs in `src/proxy.ts`, Next's per-request hook —
  named for the framework's file convention, not for a domain concept.
- **Local-only run** — a development run started by `npm run dev:app`, with
  no public origin and so no tunnel. The connectable platforms that reach
  OmniPost through that origin cannot be connected in one, so their
  configuration is dropped rather than rejected, and named at startup. The
  strict rules still bind `npm run dev` and production, which is what keeps
  the relaxation from ever reaching a deployment.

## Where decisions live

- `docs/prd/` — what's being built and why, one file per shipped
  increment (or, for `roadmap.md`, the living index across increments).
  Only the v0.1 PRD is tracked in git, as the record of the walking
  skeleton; the rest are local working documents, because their durable
  decisions land here, in `docs/adr/`, and in the issues they produce.
- `docs/adr/` — architectural decisions that outlive any single PRD
  (hosting, schema shape, cross-platform constraints).
