## Repository orientation

Start with [CONTRIBUTING.md](CONTRIBUTING.md), [CONTEXT.md](CONTEXT.md), and
[docs/architecture.md](docs/architecture.md). See the [ADR index](docs/adr/README.md)
for accepted and superseded decisions. Local planning files follow
`docs/prd/<feature-slug>/spec.md` with ordered ticket files alongside; publish
tracker issues only when explicitly requested.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (RaynandaSantoso/omnipost), using the gh CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (CONTEXT.md + docs/adr/ at repo root). See `docs/agents/domain.md`.
