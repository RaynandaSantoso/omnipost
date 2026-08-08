# omnipost
Upload a short video, upload everywhere

## Running (self-hosted)

```sh
cp .env.example .env
docker compose up
```

This builds the image, runs database migrations automatically, and starts the app on http://localhost:3000. Uploads, credentials, and the SQLite database live under `/app/data`, mounted as a named Docker volume (`omnipost-data`) so they survive a restart or upgrade. All configuration is supplied via environment variables in `.env` — see `.env.example` for what's available.

Health can be checked at `GET /api/health`, which reports `200` when the app and its database are both reachable.

### Access gate

The app may run open only when it has no public origin. Setting `PUBLIC_BASE_URL` without a non-empty `ACCESS_PASSWORD` makes boot fail with a configuration error. When the password is set, every route except the deliberately public login, health, legal, verification, and signed-media routes requires it.

Enter it once at `/login`; a session cookie (`omnipost_session`) is issued that's `HttpOnly`, `Secure` when served over HTTPS, and lasts 30 days, renewing on every request you make (sliding expiry — an idle session still expires 30 days after your last visit). Repeated wrong passwords back off exponentially (1s, 2s, 4s, ... capped at 60s) per source IP. This is a single shared password, not a user-accounts system — there's no username, no per-user session, no logout-everywhere. `POST /api/auth/logout` clears your own session cookie.

**TLS is your responsibility, not the app's.** The app doesn't refuse to boot without HTTPS — it can't always prove a reverse proxy in front of it is terminating TLS — but running any non-localhost deployment without one is unsupported: your password and session cookie would be sent in the clear. Put a TLS-terminating reverse proxy (Caddy, nginx, a platform load balancer) in front of any instance reachable off your own machine. If the app receives a plaintext request, it logs a one-time warning. Source-IP rate limiting trusts the *last* hop of `X-Forwarded-For` — the address your reverse proxy itself observed — so it assumes exactly one reverse proxy in front of the app.

### Uploads and the job engine

An upload is durable work, not a request that has to finish while you wait: `POST /api/uploads` writes an `Upload` and one `Job` per target platform and returns immediately. A background runner in the same process claims each job by taking a **lease** (`JOB_LEASE_MS`, default 30s) and renews it while it works, so a job is never picked up twice — and a job whose worker died stops being anyone's job once its lease lapses, rather than sitting in `uploading` forever.

- **Restarts are safe.** On boot, jobs holding an expired lease go back to `pending` (after a backoff, so a job that reliably kills the process can't spin the fresh instance); jobs that were already out of attempts are marked `failed`. On `SIGTERM` the runner stops claiming, waits out the upload it's running, hands back any lease still held (without spending one of its attempts), and exits.
- **Transient failures retry themselves.** A retryable failure (rate limit, 5xx, network) is rescheduled with exponential backoff plus jitter — `JOB_BACKOFF_BASE_MS` doubling per attempt up to `JOB_BACKOFF_MAX_MS` — until `JOB_MAX_ATTEMPTS` is spent, after which the job stops and waits for you.
- **Real rejections don't.** A terminal failure (bad credentials, rejected content, quota exhausted) is never retried automatically — retrying it would just hammer a platform that is telling you no.

### Connecting YouTube

In your own Google Cloud project, enable the YouTube Data API v3, create an OAuth 2.0 **Web application**, and add the exact callback URL configured in `YOUTUBE_REDIRECT_URI` (for example, `https://your-host/api/platforms/youtube/callback`). Publish the OAuth consent screen to **Production**; Testing status issues refresh tokens that expire after seven days. Fill in `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`, and `TOKEN_ENCRYPTION_KEY`, then use **Connect YouTube** on the dashboard.

`TOKEN_ENCRYPTION_KEY` must be a base64-encoded 32-byte key (for example, `openssl rand -base64 32`). Platform credentials are encrypted with AES-256-GCM in SQLite, and a domain-separated key derived from it signs public media URLs. Store the database volume with restrictive permissions. Key rotation is out of scope for v0.1: changing this key makes existing connections unreadable and immediately invalidates outstanding media URLs, so disconnect and reconnect platforms afterwards.

### Expiring public media URLs

Instagram receives an HTTPS URL under `/api/uploads/:id/file` so it can fetch
the stored video while OmniPost is running locally. Each URL is constructed
from `PUBLIC_BASE_URL`, contains a random upload-scoped HMAC authorization
value, and expires after one hour. The route deliberately bypasses the shared
password gate because Meta cannot supply a browser session; the signature and
expiry are its authorization boundary. Treat generated URLs as sensitive and
keep `npm run dev` running until Instagram finishes processing the video.

## Production Launcher (macOS)

Install and authenticate ngrok, then configure `PUBLIC_BASE_URL` and
`ACCESS_PASSWORD` in `.env`. Double-click
`OmniPost.app`, or drag that app to the Dock without moving it out of
the repository. The Launcher opens a Terminal-owned production session,
builds OmniPost when no production build exists, starts the app and reserved
tunnel, prevents idle sleep, and opens a browser tab after the health endpoint
answers. Keep the Terminal window open for logs; press `Ctrl+C` there to stop
the app and tunnel together.

Launching it again while OmniPost is answering only brings its browser tab
forward. The same production session can be started from a terminal with
`npm run launch`. After changing code, stop the session and force a fresh build
with `npm run launch -- --rebuild`.

## Local development (without Docker)

```sh
cp .env.example .env
npm install
npm run dev
```

`npm run dev` is the all-in-one development launcher. It always starts
OmniPost and exactly one shared ngrok tunnel for every configured platform.
`PUBLIC_BASE_URL` and `ACCESS_PASSWORD` are required for this command. It
prints both the local and public URLs at startup. Keep the terminal and
computer running until all platform jobs have settled. Press `Ctrl+C` once to
stop OmniPost and ngrok together.

To start only the local app without any companion services, run:

```sh
npm run dev:app
```

This is the local-only mode, and it does not serve `PUBLIC_BASE_URL` even when
that variable remains in `.env`. Any platform
configuration that only works behind the shared tunnel — the TikTok and
Instagram redirect URIs — is skipped rather than rejected, so a `.env` left
over from a tunnel session still starts. Those platforms cannot be connected
in such a run, and startup says which ones it skipped. Use `npm run dev` when
you need them. YouTube is unaffected: its redirect URI is a localhost URL.

`DATABASE_URL` in `.env.example` defaults to a SQLite file under `./data/`,
created on first run.

### Shared public runtime

Install and authenticate the ngrok agent once, then set `PUBLIC_BASE_URL` in
`.env` to your assigned HTTPS ngrok origin, with no path, query, fragment, or
credentials. For example:

```dotenv
PUBLIC_BASE_URL="https://your-domain.ngrok-free.dev"
ACCESS_PASSWORD="choose-a-strong-shared-password"
TIKTOK_REDIRECT_URI="https://your-domain.ngrok-free.dev/api/platforms/tiktok/callback"
INSTAGRAM_REDIRECT_URI="https://your-domain.ngrok-free.dev/api/platforms/instagram/callback"
```

Each configured redirect URI must use that exact origin and its platform's
exact callback path. Register the TikTok URI in TikTok Login Kit and the
Instagram URI in the Meta developer app. The all-in-one `npm run dev` command
uses the shared origin's hostname for one ngrok tunnel, even when both
platforms are configured. Use `npm run dev:app` instead when no tunnel is
needed; it skips these redirect URIs rather than requiring them to be removed.

### Instagram connection setup

OmniPost uses **Instagram API with Instagram Login**. The Instagram account
must be a Business or Creator account, and that is the only requirement — no
Facebook Page is involved anywhere in the flow.

Create an operator-owned Meta developer app and add the Instagram use case.
Register the exact `INSTAGRAM_REDIRECT_URI` under it, and request the
`instagram_business_basic` and `instagram_business_content_publish`
permissions. Then set `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`,
`INSTAGRAM_REDIRECT_URI`, `PUBLIC_BASE_URL`, and `TOKEN_ENCRYPTION_KEY` in
`.env`, and use **Connect Instagram** on the dashboard.

> `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` are the **Instagram** app
> credentials, shown on the Instagram use case's own settings card. They are
> not the Facebook app id and secret from the app dashboard — those are
> different values, and they will not authenticate against this flow. An
> installation set up before this change must replace both.

Disconnecting deletes OmniPost's stored token. Instagram Login has no revoke
endpoint, so Meta keeps its record of the grant until you also remove OmniPost
under Instagram's **Apps and websites** settings.

## Tests

```sh
npm test
```
