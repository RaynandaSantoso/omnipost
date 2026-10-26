# ADR-0003: Keep TikTok Direct Post private until public posting is reviewed

Status: accepted. Public posting is not implemented; this repository does not
establish the review status of any operator's TikTok application.

## Context

The [TikTok adapter](../../src/lib/adapters/tiktok-adapter.ts) uses the Direct
Post endpoint `/v2/post/publish/video/init/`, transfers the file, and polls for
completion. It requests `SELF_ONLY` visibility.

TikTok restricts unaudited Direct Post clients to private viewing. This is
different from the Upload API's inbox notification flow; a successful private
Direct Post is not a draft waiting for an inbox confirmation. See TikTok's
[Direct Post guide](https://developers.tiktok.com/docs/en/content-posting-api-get-started)
and [Upload API reference](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video).

## Decision

Keep the adapter's requested visibility fixed at `SELF_ONLY`. Do not infer
public-posting approval from a successful connection or transfer. The returned
`tiktok://publish/<id>` value is a publishing reference, not a public web URL.

## Consequences and revisit conditions

A completed TikTok Job means private Direct Post completion, not public reach.
API access and application review remain operator-owned prerequisites.

Public posting needs a separate implementation decision and review. TikTok's
[sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
require creator information and user-selected privacy and interaction controls;
its intended-use rules also exclude private/internal account-management tools.
OmniPost's single-operator scope is therefore a review constraint, not an
assurance that approval will follow. Changing a visibility constant alone does
not establish eligibility or implement those controls.

External documentation checked on 2026-10-26. Recheck it when revisiting this
decision; provider requirements can change independently of this repository.
