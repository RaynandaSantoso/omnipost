# ADR-0003: Build the TikTok adapter against SELF_ONLY now, flip to public later

Status: accepted

## Context

TikTok's Content Posting API forces `SELF_ONLY` visibility (private —
lands in the operator's TikTok inbox, requiring a manual tap to actually
publish) on any app that hasn't passed TikTok's Direct Post + public-
visibility audit. This is enforced server-side by TikTok based on the
calling app's review status; it is not a request parameter the adapter
can override. Unlike Google's OAuth verification (which exempts apps
under 100 users), TikTok grants no user-count exemption — a personal,
single-operator tool still needs the same audit as a multi-tenant SaaS.

The audit requires a written use-case description and a screen-recording
demo of the actual posting flow, submitted by the operator through the
TikTok Developer Portal, with a turnaround of days to weeks.

## Decision

Ship the `TikTokAdapter` now, targeting `SELF_ONLY`. The operator submits
the audit application in parallel, as a separate, non-blocking task. Once
(if) approved, flip the requested visibility to public — the same
one-line-change pattern already used for YouTube's privacy default,
which shipped private in `d171c43` and became public in `73b31ee` once
that was the confirmed intent.

## Consequences

- Every TikTok post is private-until-manually-published until the audit
  clears — a real UX gap versus YouTube/Instagram, disclosed to the
  operator rather than hidden.
- No code needs to branch on audit status: the adapter always requests
  the same visibility value, and that value is what changes post-audit.
- If the audit is rejected or never submitted, TikTok integration
  permanently means "lands in your inbox, tap to post" — worth revisiting
  whether that's still valuable enough to keep, but not a reason to block
  building it now.
