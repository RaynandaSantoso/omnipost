# ADR-0004: Use the operator's machine with a reserved public tunnel

Status: accepted; supersedes [ADR-0001](0001-oracle-free-vm-and-dynamic-dns.md).

## Context

OmniPost is a single-operator application that needs a persistent process,
SQLite, stored videos, and background uploads. Those requirements do not require
a dedicated cloud VM when the operator can keep their own machine running for
the duration of a publishing session.

OAuth providers need registered callback URLs, and Instagram retrieves videos
from OmniPost over HTTPS during publishing. A reserved hostname survives
restarts; an ephemeral tunnel URL would require repeated provider setup.

## Decision

Use the operator's Mac as the primary deployment target. The production
Launcher starts a production Next.js build, a single ngrok tunnel at
`PUBLIC_BASE_URL`, and idle-sleep prevention as one managed Launcher session.
The macOS menu-bar application and terminal commands share that lifecycle.

The public tunnel is required by this Launcher workflow. TikTok and Instagram
callbacks use its origin; YouTube's configured callback is validated separately
and may use localhost. A configured `PUBLIC_BASE_URL` requires an
`ACCESS_PASSWORD` of at least 16 characters.

## Alternatives and scope

- A cloud VM could provide availability independent of the operator's machine,
  but adds host maintenance and an external deployment to operate.
- Docker remains an alternative self-hosting workflow with a persistent volume.
  It does not start ngrok; its operator supplies public routing and TLS when
  needed. It is not deprecated by this decision.
- `npm run dev` starts the development server and tunnel. `npm run dev:app`
  starts only the development server for local work, including dry-run testing;
  it skips TikTok and Instagram callback configuration. Neither development
  command replaces the production Launcher for daily use.

## Consequences

The public URL is available only while the machine and session are running.
The Launcher prevents idle sleep, but closing the lid or losing connectivity
can still interrupt work. Job Leases allow recovery after interruption;
YouTube's persisted Transfer state supports resuming bytes. This does not
promise resumable transfers or duplicate-free retries for every platform.

A reserved origin and password make the app reachable without a separate VM,
but the operator still maintains their machine, tunnel configuration, provider
credentials, and local data. See the [README](../../README.md) for setup and
lifecycle commands.

Revisit if publishing must continue while the operator's machine is unavailable
or a stable tunnel hostname is no longer usable.
