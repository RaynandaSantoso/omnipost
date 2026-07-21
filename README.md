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
