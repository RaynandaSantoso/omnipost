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

By default the app is open — no login. If you set `ACCESS_PASSWORD` in `.env`, every route (except `/login` and `/api/health`) starts requiring that password.

Enter it once at `/login`; a session cookie (`omnipost_session`) is issued that's `HttpOnly`, `Secure` when served over HTTPS, and lasts 30 days, renewing on every request you make (sliding expiry — an idle session still expires 30 days after your last visit). Repeated wrong passwords back off exponentially (1s, 2s, 4s, ... capped at 60s) per source IP. This is a single shared password, not a user-accounts system — there's no username, no per-user session, no logout-everywhere. `POST /api/auth/logout` clears your own session cookie.

**TLS is your responsibility, not the app's.** The app doesn't refuse to boot without HTTPS — it can't always prove a reverse proxy in front of it is terminating TLS — but running any non-localhost deployment without one is unsupported: your password and session cookie would be sent in the clear. Put a TLS-terminating reverse proxy (Caddy, nginx, a platform load balancer) in front of any instance reachable off your own machine. If the app receives a plaintext request, it logs a one-time warning. Source-IP rate limiting trusts the *last* hop of `X-Forwarded-For` — the address your reverse proxy itself observed — so it assumes exactly one reverse proxy in front of the app.

### Uploads and the job engine

An upload is durable work, not a request that has to finish while you wait: `POST /api/uploads` writes an `Upload` and one `Job` per target platform and returns immediately. A background runner in the same process claims each job by taking a **lease** (`JOB_LEASE_MS`, default 30s) and renews it while it works, so a job is never picked up twice — and a job whose worker died stops being anyone's job once its lease lapses, rather than sitting in `uploading` forever.

- **Restarts are safe.** On boot, jobs holding an expired lease go back to `pending` (after a backoff, so a job that reliably kills the process can't spin the fresh instance); jobs that were already out of attempts are marked `failed`. On `SIGTERM` the runner stops claiming, waits out the upload it's running, hands back any lease still held (without spending one of its attempts), and exits.
- **Transient failures retry themselves.** A retryable failure (rate limit, 5xx, network) is rescheduled with exponential backoff plus jitter — `JOB_BACKOFF_BASE_MS` doubling per attempt up to `JOB_BACKOFF_MAX_MS` — until `JOB_MAX_ATTEMPTS` is spent, after which the job stops and waits for you.
- **Real rejections don't.** A terminal failure (bad credentials, rejected content, quota exhausted) is never retried automatically — retrying it would just hammer a platform that is telling you no.

### Connecting YouTube

In your own Google Cloud project, enable the YouTube Data API v3, create an OAuth 2.0 **Web application**, and add the exact callback URL configured in `YOUTUBE_REDIRECT_URI` (for example, `https://your-host/api/platforms/youtube/callback`). Publish the OAuth consent screen to **Production**; Testing status issues refresh tokens that expire after seven days. Fill in `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`, and `TOKEN_ENCRYPTION_KEY`, then use **Connect YouTube** on the dashboard.

`TOKEN_ENCRYPTION_KEY` must be a base64-encoded 32-byte key (for example, `openssl rand -base64 32`). Tokens are encrypted with AES-256-GCM in SQLite. Store the database volume with restrictive permissions. Key rotation is out of scope for v0.1: changing this key makes existing connections unreadable, so disconnect and reconnect YouTube afterwards.

## Local development (without Docker)

```sh
cp .env.example .env
npm install
npm run dev
```

`DATABASE_URL` in `.env.example` defaults to a SQLite file under `./data/`, created on first run.

## Tests

```sh
npm test
```
