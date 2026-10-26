# Domain documentation for contributors and agents

OmniPost has one domain context. Before changing behavior, read
[CONTEXT.md](../../CONTEXT.md) and the relevant records in
[docs/adr/](../adr/README.md). Use [the architecture guide](../architecture.md)
to locate implementation boundaries, and [CONTRIBUTING.md](../../CONTRIBUTING.md)
for setup and checks.

Use the glossary's terms in code, tests, plans, and issues. Add a concise
definition when introducing a new domain concept; keep implementation details
in the architecture guide rather than expanding the glossary into a spec.

If a change contradicts an accepted ADR, explain the conflict and update or
supersede that record as part of the change. Preserve the old rationale and
link its replacement. Do not silently treat a superseded plan as current.

Local specs and tickets live under `docs/prd/<feature-slug>/`, following the
repository instructions. They may be absent in a fresh clone; tracked docs must
still explain shipped behavior and its rationale without them.
