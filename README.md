# omnipost
Upload a short video, upload everywhere

## Running (self-hosted)

```sh
cp .env.example .env
docker compose up
```

This builds the image, runs database migrations automatically, and starts the app on http://localhost:3000. Uploads, credentials, and the SQLite database live under `/app/data`, mounted as a named Docker volume (`omnipost-data`) so they survive a restart or upgrade. All configuration is supplied via environment variables in `.env` — see `.env.example` for what's available.

Health can be checked at `GET /api/health`, which reports `200` when the app and its database are both reachable.

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
