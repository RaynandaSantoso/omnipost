# ADR-0002: Generalize PlatformConnection and Job.platform before adding more platforms

Status: accepted

## Context

`PlatformConnection.channelId` is YouTube-specific naming baked in during
v0.1, when YouTube was the only platform. The UI currently shows this raw
opaque id directly to the operator, with no human-readable name. `Job.platform`
is a bare, unvalidated string. Two more platforms (TikTok, Instagram) are
about to be added on top of this shape.

Prisma has no true enum support on the SQLite provider — an "enum" there
is enforced only via a CHECK constraint added through raw SQL, and SQLite
can only change a CHECK constraint by rebuilding the whole table (no
`ALTER TABLE ... ALTER CONSTRAINT`). Every new platform under that
approach would mean a table-rebuilding migration.

## Decision

- Rename `PlatformConnection.channelId` → `externalAccountId` (the
  platform's own opaque identifier — works for TikTok's `open_id`,
  Instagram's user id, etc. without further renaming).
- Add `PlatformConnection.externalAccountLabel`: a human-readable
  handle/display name, shown in the UI instead of the raw id.
- Keep `Job.platform` as a plain string, validated at the application
  layer through a single shared Zod/TS union type used everywhere a
  platform value is produced or consumed — not a database-level enum or
  CHECK constraint.

## Consequences

- Adding TikTok/Instagram/future platforms costs one line in the shared
  union type, no migration.
- Nothing prevents an invalid platform string from reaching the database
  directly (e.g. a hand-run SQL statement) — the guarantee is
  application-layer only. Accepted: nothing outside this codebase writes
  to this table.
- The existing real YouTube `PlatformConnection` row (already connected,
  live data, not just test fixtures) needs `externalAccountLabel`
  backfilled as part of the migration — it has no label today, only the
  channel id.
- Every place currently reading `channelId` (API responses, the
  dashboard's "Connected to `<id>`" display) needs updating in the same
  pass — tracked in issue #13.
