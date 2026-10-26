# ADR-0002: Platform-neutral account identifiers and application-validated platforms

Status: accepted.

## Context

The initial YouTube integration stored its account identifier as
`PlatformConnection.channelId` and displayed that opaque value in the dashboard.
Adding TikTok and Instagram required a name that did not imply a YouTube
channel, plus a readable account label.

Platform values also need validation. A database CHECK constraint would couple
each new destination to a schema migration, and changing such a constraint in
SQLite requires rebuilding its table. The application already validates input
at its boundaries, so it can own the allowed platform set.

## Decision

- Store the platform's identifier in `externalAccountId` and its readable name
  in nullable `externalAccountLabel`.
- Keep platform columns as strings. Validate platform values using the shared
  `platformSchema` and inferred `Platform` type in
  [src/lib/platform.ts](../../src/lib/platform.ts).
- Keep platform-specific account discovery inside each OAuth integration.

## Consequences

Adding an allowed platform value does not require a database migration, though
an integration still needs an adapter, connection flow, upload policy, and UI.
Direct database writes can bypass platform validation; application code must
validate values before storing or using them.

The [migration](../../prisma/migrations/20260728120000_rename_channel_id_to_external_account_id/migration.sql)
renames `channelId` without discarding identifiers and adds a nullable label.
The startup backfill in [youtube-oauth.ts](../../src/lib/youtube-oauth.ts)
fetches labels for older YouTube connections. It can retry on a later boot if
lookup fails; a missing label does not erase the connection. New connections
save their identifier and label together.
