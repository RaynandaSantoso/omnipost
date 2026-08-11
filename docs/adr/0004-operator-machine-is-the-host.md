# ADR-0004: The operator's machine is the host, reached through a reserved tunnel

Status: accepted (supersedes ADR-0001)

## Context

ADR-0001 chose an Oracle Cloud Always Free VM plus a dynamic-DNS domain, on
the reasoning that OmniPost needs a persistent process, disk-resident SQLite
and video files, and long-running uploads — none of which a serverless
platform gives. That reasoning still holds. What changed is who runs the
persistent process.

In practice the operator has been running OmniPost on their Mac the whole
time, reaching the outside world through a **reserved** ngrok domain
(`PUBLIC_BASE_URL`). The VM was never stood up. Treating the laptop as the
host is therefore not a new plan; it is the accurate description of the one
already in use.

Two facts make it viable rather than merely convenient:

- The ngrok domain is **reserved, not ephemeral**. It survives restarts, so
  the OAuth redirect URIs registered with Google, TikTok and Meta stay valid
  across sessions. A random per-session URL would have made this untenable.
- Crash and sleep recovery already exist in the job engine: a startup sweep
  reclaims expired leases, every post-claim write is guarded by "still my
  lease", and transfer state plus the resume-query let a half-sent video
  resume at its byte offset. A host that sleeps is a host this design
  already tolerates.

## Decision

**The operator's own machine is the deployment target.** OmniPost is started
by a dock-pinnable launcher that runs a production build (`next start`) and
the ngrok tunnel together, and is reached at the reserved public origin.

The tunnel is **not optional and not conditional**. Instagram fetches the
video over the public media URL at publish time, and every OAuth callback
lands on that origin. There is no useful mode in which OmniPost runs without
it, so the launcher does not offer one.

**`ACCESS_PASSWORD` becomes a hard requirement whenever `PUBLIC_BASE_URL` is
set**, enforced at config validation rather than left to discipline. ADR-0001
predicted this obligation would arrive with the VM; it arrived with the
tunnel instead, and the exposure is identical — the reserved hostname is
registered with two platform reviewers and sits in plain text in `.env`.

## Consequences

- **Availability is the operator's presence.** OmniPost is up when the Mac is
  awake and the launcher is running. Accepted deliberately: this is a
  single-operator tool, and jobs resume rather than fail when the host sleeps.
  The launcher runs under `caffeinate -i` so an unattended upload is not
  killed by idle sleep; closing the lid still sleeps, and recovery covers it.
- **`Dockerfile` and `docker-compose.yml` lose their reason to exist.** They
  were written for the VM. Left in place for now as the self-host path for
  anyone else, but they are no longer the deployment story and should not be
  treated as the source of truth for how OmniPost runs.
- **The "easy to show someone" goal is preserved but conditional.** The public
  URL still works from a phone, still demos in one link — but only while the
  operator's machine is running. This was the strongest argument for the VM
  and it is the real thing being traded away.
- **`npm run dev` stops being the way OmniPost is *used*.** It remains the way
  OmniPost is *developed*. The launcher is the daily driver, and it runs a
  production build — so dev-mode behaviour (on-demand compilation, StrictMode
  double-invoked effects) no longer shapes the operator's experience.
- Revisit if: OmniPost needs to be reachable when the machine is not, the
  ngrok free tier stops reserving the domain, or the demo-on-demand property
  turns out to matter more than the operator expects.
