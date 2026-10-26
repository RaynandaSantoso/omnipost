# Contributing to OmniPost

## Start here

Read the [README](README.md) for setup and current platform behavior,
[CONTEXT.md](CONTEXT.md) for domain language, and
[docs/architecture.md](docs/architecture.md) for the upload flow and code map.
The [ADR index](docs/adr/README.md) distinguishes current decisions from replaced
plans. You do not need past chats, an existing database, or local PRDs.

## Set up a checkout

Use Node.js 22 and npm, matching the Docker image. Native SQLite bindings may
need Python and C/C++ build tools if a prebuilt binary is unavailable.

```sh
npm ci
npx prisma generate
cp .env.example .env
npm run dev:app
```

Copy `.env` only for a new checkout; preserve existing configuration. Open
http://localhost:3000. With the example configuration and no connected
accounts, uploads use dry-run and do not publish externally. The server applies
checked-in migrations and seeds its single User on boot. Generated Prisma code
is ignored by git, so generate it before running checks in a fresh checkout.

Use the README's shared public runtime instructions and `npm run dev` to work
on TikTok or Instagram. Do not use real platform credentials merely to run the
test suite. For the native macOS Launcher, install the Xcode Command Line Tools
(`xcode-select --install`) so the app wrapper can compile its Swift source.

## Check a change

```sh
npm test
npm run lint
npm run typecheck
```

For a focused test run, pass its file, for example:
`npm test -- tests/job-engine.test.ts`. Use `npm run build` to verify production
compilation when changing server or UI behavior. Tests live under `tests/` and
run with Vitest in a Node environment. Follow nearby tests for temporary
storage and provider HTTP mocks.

Schema changes need a checked-in migration under `prisma/migrations/` and an
updated generated client locally. Never commit `.env`, databases, uploaded
videos, credentials, or machine-specific agent permissions.

## Keep the repository understandable

- Define domain terms in `CONTEXT.md`; explain implementation in
  `docs/architecture.md` and operational steps in the README.
- Record durable architectural trade-offs in `docs/adr/`, with the context,
  decision, consequences, and links needed to understand each record alone.
- Describe shipped behavior in the present tense. Label historical constraints
  and unimplemented plans explicitly. Do not use an old chat, issue, or commit
  as the only explanation for a decision.
- Store local plans under `docs/prd/<feature-slug>/spec.md` and ordered tickets
  beside them as `01-<ticket-slug>.md`, `02-<ticket-slug>.md`, and so on. Each
  ticket must include its user-visible outcome, blocking tickets,
  `ready-for-agent` status, and testable acceptance criteria.
- `docs/prd/` is ignored by git and may be absent in a fresh clone. Move durable
  explanations into tracked documentation. Publish issues only when explicitly
  requested; see [the tracker guide](docs/agents/issue-tracker.md).
